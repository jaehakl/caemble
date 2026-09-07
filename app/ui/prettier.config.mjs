/** @type {import('prettier').Config} */
export default {
  plugins: ['prettier-plugin-tailwindcss'],
  printWidth: 120,
  semi: false,
  singleQuote: true,
  endOfLine: 'auto',
  tailwindStylesheet: './src/index.css',
  trailingComma: 'all',
}
