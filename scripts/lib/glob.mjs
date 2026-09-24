// scripts/lib/glob.mjs
//
// Minimal glob matching shared by npm source-path maps and zip include
// filters. "*" matches within one path segment, "**" matches any depth.

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compiles a glob pattern (using only "*" and "**") to an anchored RegExp. */
export function globToRegExp(pattern) {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** The literal path prefix before the first wildcard, up to and
 * including the last "/" (used to resolve a glob's destination dir). */
export function globStaticPrefix(pattern) {
  const starIndex = pattern.search(/\*/);
  const prefix = starIndex === -1 ? pattern : pattern.slice(0, starIndex);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : prefix.slice(0, lastSlash + 1);
}
