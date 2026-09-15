// Vite bundles imported stylesheets; TypeScript only needs to know the import exists.
declare module '*.css';

// Vite emits an imported asset as a file and gives its URL (vite.config.ts sets
// assetsInlineLimit to 0: a data: URL would be refused by the page's CSP).
declare module '*.svg' {
  const url: string;
  export default url;
}
