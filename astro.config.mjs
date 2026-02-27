import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://lvyouyou.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
