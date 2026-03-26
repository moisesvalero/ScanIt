/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        kronos: {
          black: '#020202',
          surface: '#0A0A0A',
          border: '#1A1A1A',
          gold: '#00e5ff',
          alert: '#E63946',
          ok: '#22C55E',
          warn: '#F59E0B'
        }
      },
      boxShadow: {
        'neon-gold': '0 0 24px rgba(0, 229, 255, 0.24)',
        'neon-red': '0 0 24px rgba(230, 57, 70, 0.24)',
        'neon-green': '0 0 24px rgba(34, 197, 94, 0.24)',
        'neon-warn': '0 0 24px rgba(245, 158, 11, 0.24)'
      },
      backdropBlur: {
        xs: '2px'
      }
    }
  },
  plugins: []
};
