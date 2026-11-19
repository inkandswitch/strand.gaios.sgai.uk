import ignore, { type Ignore } from "ignore";

// Copied from pushwork's `src/attributes.ts`: git sync reads a workspace's
// `.pushworkattributes` exactly as pushwork does, so a folder synced through
// either one maps to the same files. Keep the two in step by hand.
//
// `.pushworkattributes` assigns attributes to paths, modeled on
// `.gitattributes`. A file may sit in any directory, and its rules apply only
// to paths under that directory (patterns are relative to the file's own
// location). Deeper files override shallower ones for the paths they cover.
//
// Format: one `<pattern> <attr>...` rule per line; blank lines and lines
// starting with `#` are ignored. Patterns are gitignore-style globs. An
// attribute token is `name` (set) or `-name` (unset). The last rule that
// matches a given path wins within a file.
//
// - `artifact`: a path with `artifact` set stores its text content as an
//   atomic ImmutableString instead of a merge-able text.
// - `datatype=<type>`: a path holding a JSON object is stored as a JSON
//   document of that Patchwork datatype, with `@patchwork.type` set to
//   `<type>`. On the same line, `import=<url>` sets
//   `@patchwork.suggestedImportUrl`, and `strip-metadata` leaves the
//   `@patchwork` field out of the file. `-datatype` unsets an earlier rule.
export const ATTRIBUTES_FILE = ".pushworkattributes";

const ARTIFACT = "artifact";
const DATATYPE = "datatype";
const IMPORT = "import";
const STRIP_METADATA = "strip-metadata";

// The Patchwork datatype a `datatype=` rule assigns to a path.
export type Datatype = {
  type: string;
  importUrl?: string;
  stripMetadata: boolean;
};

type Rule = { ig: Ignore; set: boolean };

// `datatype: null` is a `-datatype` rule: it unsets earlier matches.
type DatatypeRule = { ig: Ignore; datatype: Datatype | null };

export class Attributes {
  private constructor(
    private readonly artifactRules: Rule[],
    private readonly datatypeRules: DatatypeRule[],
  ) {}

  // Parse the text of a `.pushworkattributes` file.
  static parse(text: string): Attributes {
    const artifactRules: Rule[] = [];
    const datatypeRules: DatatypeRule[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [pattern, ...attrs] = line.split(/\s+/);
      if (!pattern) continue;
      // One matcher per line, to honor last-match-wins ordering.
      const ig = ignore().add(pattern);
      let type: string | null | undefined;
      let importUrl: string | undefined;
      let stripMetadata = false;
      for (const attr of attrs) {
        const unset = attr.startsWith("-");
        const token = unset ? attr.slice(1) : attr;
        const eq = token.indexOf("=");
        const name = eq < 0 ? token : token.slice(0, eq);
        const value = eq < 0 ? undefined : token.slice(eq + 1);
        switch (name) {
          case ARTIFACT:
            artifactRules.push({ ig, set: !unset });
            break;
          case DATATYPE:
            if (unset) type = null;
            else if (value) type = value;
            break;
          case IMPORT:
            importUrl = unset ? undefined : value || undefined;
            break;
          case STRIP_METADATA:
            stripMetadata = !unset;
            break;
        }
      }
      if (type === null) {
        datatypeRules.push({ ig, datatype: null });
      } else if (type !== undefined) {
        datatypeRules.push({ ig, datatype: { type, importUrl, stripMetadata } });
      }
    }
    return new Attributes(artifactRules, datatypeRules);
  }

  get hasArtifactRules(): boolean {
    return this.artifactRules.length > 0;
  }

  // The last matching `artifact` rule's verdict, or undefined when none match.
  artifactOf(posixPath: string): boolean | undefined {
    let result: boolean | undefined;
    for (const { ig, set } of this.artifactRules) {
      if (ig.ignores(posixPath)) result = set;
    }
    return result;
  }

  // The last matching `datatype` rule's datatype, `null` when that rule unsets
  // it, undefined when none match.
  datatypeOf(posixPath: string): Datatype | null | undefined {
    let result: Datatype | null | undefined;
    for (const { ig, datatype } of this.datatypeRules) {
      if (ig.ignores(posixPath)) result = datatype;
    }
    return result;
  }
}

// Every `.pushworkattributes` file of a tree, each scoped to its own
// directory, consulted shallowest first: on a conflict the deepest file that
// matches a path wins.
export class AttributesTree {
  constructor(private readonly files: { dir: string; attrs: Attributes }[]) {}

  get hasArtifactRules(): boolean {
    return this.files.some(({ attrs }) => attrs.hasArtifactRules);
  }

  isArtifact(posixPath: string): boolean {
    let result = false;
    for (const { dir, attrs } of this.files) {
      const rel = relativeTo(dir, posixPath);
      if (rel === undefined) continue;
      const match = attrs.artifactOf(rel);
      if (match !== undefined) result = match;
    }
    return result;
  }

  datatypeOf(posixPath: string): Datatype | undefined {
    let result: Datatype | null | undefined;
    for (const { dir, attrs } of this.files) {
      const rel = relativeTo(dir, posixPath);
      if (rel === undefined) continue;
      const match = attrs.datatypeOf(rel);
      if (match !== undefined) result = match;
    }
    return result ?? undefined;
  }
}

// The attributes carried by a tree's files: every `.pushworkattributes` entry
// in `files`, parsed and scoped to its own directory.
export function attributesTreeOf(files: ReadonlyMap<string, Uint8Array>): AttributesTree {
  const found: { dir: string; attrs: Attributes }[] = [];
  for (const [posixPath, bytes] of files) {
    const dir = attributesDirOf(posixPath);
    if (dir === undefined) continue;
    found.push({ dir, attrs: Attributes.parse(new TextDecoder().decode(bytes)) });
  }
  found.sort((a, b) => depthOf(a.dir) - depthOf(b.dir) || (a.dir < b.dir ? -1 : 1));
  return new AttributesTree(found);
}

export function isAttributesFile(posixPath: string): boolean {
  return attributesDirOf(posixPath) !== undefined;
}

function attributesDirOf(posixPath: string): string | undefined {
  if (posixPath === ATTRIBUTES_FILE) return "";
  if (posixPath.endsWith("/" + ATTRIBUTES_FILE)) {
    return posixPath.slice(0, -(ATTRIBUTES_FILE.length + 1));
  }
  return undefined;
}

const depthOf = (dir: string) => (dir === "" ? 0 : dir.split("/").length);

function relativeTo(dir: string, posixPath: string): string | undefined {
  if (dir === "") return posixPath;
  if (posixPath.startsWith(dir + "/")) return posixPath.slice(dir.length + 1);
  return undefined;
}

// What a tree's rules decide for a path, with pushwork's default artifact
// directories (`dist`) when no attributes file sets any artifact rule.
export type Rules = {
  isArtifact(posixPath: string): boolean;
  datatypeOf(posixPath: string): Datatype | undefined;
};

const DEFAULT_ARTIFACT_DIRECTORIES = ["dist"];

export function rulesOf(files: ReadonlyMap<string, Uint8Array>): Rules {
  const attrs = attributesTreeOf(files);
  return {
    isArtifact: attrs.hasArtifactRules
      ? (p) => attrs.isArtifact(p)
      : (p) => DEFAULT_ARTIFACT_DIRECTORIES.some((d) => p === d || p.startsWith(d + "/")),
    datatypeOf: (p) => attrs.datatypeOf(p),
  };
}
