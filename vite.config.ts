import { defineConfig } from 'vite';

// Relative base so the built app runs from any path, including a
// GitHub Pages project site (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
});
