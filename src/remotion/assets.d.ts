declare module '*.woff2' {
  /** Inlined as a data URI by the webpack override, so no request leaves the page. */
  const url: string;
  export default url;
}
