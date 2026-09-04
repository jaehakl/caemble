/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Keep module dependencies acyclic.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-are-leaf-modules',
      comment: 'Contracts may only depend on other contracts or shared external packages.',
      severity: 'error',
      from: { path: '^src/contracts/' },
      to: { path: '^src/(api|app|components|features|lib|platform|routes|workbench)/' },
    },
    {
      name: 'domain-does-not-fetch',
      comment: 'Low-level domain code must receive remote data instead of importing API clients.',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/api/' },
    },
    {
      name: 'lower-layers-do-not-import-ui',
      comment: 'API, contract, and domain modules must not depend on application UI layers.',
      severity: 'error',
      from: { path: '^src/(api|contracts|lib|platform)/' },
      to: { path: '^src/(app|components|features|routes|workbench)/' },
    },
    {
      name: 'features-do-not-import-routes',
      comment: 'Routes compose features; features and shared components must not import route modules.',
      severity: 'error',
      from: { path: '^src/(components|features)/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/routes/' },
    },
    {
      name: 'application-does-not-import-cad-root-barrel',
      comment: 'Application modules import the CAD model, source, or execution owner instead of the aggregate barrel.',
      severity: 'error',
      from: { path: '^src/(features|routes|workbench)/' },
      to: { path: '^src/lib/cad/index\\.ts$' },
    },
    {
      name: 'features-do-not-import-workbench',
      comment: 'Workbench composes features; feature implementations must remain independent from the shell.',
      severity: 'error',
      from: { path: '^src/features/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/workbench/' },
    },
    {
      name: 'components-do-not-import-application-layers',
      comment: 'Reusable components must not depend on workbench, feature, or page implementations.',
      severity: 'error',
      from: { path: '^src/components/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/(app|features|routes|workbench)/' },
    },
    {
      name: 'workbench-does-not-import-routes',
      comment: 'The workbench shell composes modules and features, not route-page implementations.',
      severity: 'error',
      from: { path: '^src/workbench/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/routes/' },
    },
    {
      name: 'shared-does-not-import-application-layers',
      comment: 'Shared primitives must remain independent from application-specific UI layers.',
      severity: 'error',
      from: { path: '^src/shared/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/(app|components|features|routes|workbench)/' },
    },
    {
      name: 'routes-do-not-compose-routes',
      comment: 'Route entries should compose modules or features, not other route entries.',
      severity: 'error',
      from: { path: '^src/routes/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^src/routes/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'All imports must resolve.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '\\?(worker|url)$' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(^|/)node_modules/|\\.d\\.ts$',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    tsConfig: {
      fileName: 'tsconfig.app.json',
    },
  },
}
