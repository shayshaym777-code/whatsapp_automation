/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'wa-green': '#25D366',
        'wa-dark': '#075E54',
        'wa-light': '#128C7E',
        'wa-bg': '#0a0a0a',
        'wa-card': '#1a1a1a',
        'wa-border': '#2a2a2a'
      }
    },
  },
  plugins: [],
}

