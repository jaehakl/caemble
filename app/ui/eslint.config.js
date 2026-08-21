import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'storybook-static', 'playwright-report', 'test-results'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/lib/{cad,examples,material,quantitykind,solver}/**/*.{ts,tsx}', 'src/lib/metadata.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/app/**',
                '@/api/**',
                '@/components/**',
                '@/features/**',
                '@/pages/**',
                './**/app/**',
                './**/components/**',
                './**/features/**',
                './**/pages/**',
                '../**/app/**',
                '../**/components/**',
                '../**/features/**',
                '../**/pages/**',
              ],
              message: 'Code-to-CAD core modules cannot depend on application, page, feature, or UI layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app/**', '@/components/**', '@/features/**', '@/lib/**', '@/pages/**'],
              message: 'API modules cannot depend on application, UI, feature, page, or Code-to-CAD layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/{app,components,features,pages}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/cad/api/**',
                '@/lib/cad/compiler/**',
                '@/lib/cad/elements/**',
                '@/lib/cad/evaluation/**',
                '@/lib/cad/execution/**',
                '@/lib/cad/geometry/**',
                '@/lib/cad/model/**',
                '@/lib/cad/runner/**',
                '@/lib/cad/source/**',
                '@/lib/cad/worker/**',
                '@/lib/material/data',
                '@/lib/solver/modules/**',
              ],
              message: 'Application code must use a Code-to-CAD public barrel.',
            },
          ],
        },
      ],
    },
  },
)
