/**
 * Asset imports, which Vite resolves and TypeScript does not know about.
 *
 * `?url` gives back the built URL of a file that is emitted as an asset rather
 * than bundled -- which is how libass's worker and its WebAssembly reach the
 * renderer, since both have to be fetched at runtime rather than inlined.
 */
declare module '*?url' {
  const url: string
  export default url
}
