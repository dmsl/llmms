/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './html/**/*.html',
    './js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#6a42c2',
          light: '#8b6dd4',
          dark: '#4a2c82',
          pale: '#f2f0f6',
        },
        sidebar: {
          DEFAULT: '#f2f0f6',
          border: 'rgba(106, 66, 194, 0.2)',
        },
      },
      fontFamily: {
        sans: ['Roboto', 'Open Sans', 'system-ui', 'sans-serif'],
      },
      animation: {
        'bounce': 'bounce 1s infinite',
      },
      boxShadow: {
        'soft': '0 4px 6px -1px rgba(106, 66, 194, 0.1)',
      },
    },
  },
  plugins: [],
}
