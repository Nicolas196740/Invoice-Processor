import { defineConfig } from 'vite';

// Three pages: the app (/), and the public About (/about/) and Privacy (/privacy/) pages.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: { main: 'index.html', about: 'about/index.html', privacy: 'privacy/index.html' },
    },
  },
});
