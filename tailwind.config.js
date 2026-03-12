/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#e85d26',
          dark: '#c44d1f',
          light: '#ff7a45',
          soft: 'rgba(232, 93, 38, 0.12)',
        },
        surface: {
          DEFAULT: '#12151c',
          2: '#1a1e28',
          3: '#222735',
        },
        border: '#2a3040',
      },
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
