import type { CatalogSearchItem } from '@/api/catalog'
import { cadElementCatalog } from '@/lib/cad'
import { caembleProgramExamples, wheelAssemblyExample } from '@/lib/examples'
import { docsSectionHref, type DocsSectionId } from './docsRoute'

export type DocsKnowledgeChunk = Readonly<{
  aliases?: readonly string[]
  anchor?: string
  collapsed?: boolean
  content: string
  href: string
  id: string
  item?: string
  keywords: readonly string[]
  section: DocsSectionId
  summary: string
  title: string
}>

function manualChunk(
  chunk: Omit<DocsKnowledgeChunk, 'href'> & {
    section: 'workbench' | 'program' | 'reference' | 'troubleshooting'
  },
): DocsKnowledgeChunk {
  return Object.freeze({ ...chunk, href: docsSectionHref(chunk.section, undefined, chunk.anchor) })
}

const firstProgramExample = caembleProgramExamples[0]
const multiphysicsExample = caembleProgramExamples.find(({ id }) => id === 'electro-thermal-uniform-bar')

export const manualDocsKnowledge: readonly DocsKnowledgeChunk[] = Object.freeze([
  manualChunk({
    id: 'workbench-quickstart',
    section: 'workbench',
    anchor: 'workbench-quickstart',
    title: 'CAE Workbench 빠른 시작',
    summary: 'Experiment candidate를 준비하고 Measurement로 고정한 뒤 실행하는 전체 흐름입니다.',
    keywords: ['Quickstart', '시작', 'Candidate', 'Measurement', 'Prepared', 'Recorded', 'Launcher', 'Ready'],
    content: [
      'Caemble의 Experiment는 공통 형상과 변수, Material, solver Task, 실행 프로그램과 RecordedData 계약을 하나의 source bundle로 관리합니다.',
      '',
      '1. 로그인하고 CAE Launcher가 연결되어 있는지 확인합니다.',
      '2. Experiment 탭에서 `experiment.tsx`, `geometry.tsx`, `material.tsx`, `tasks/*.tsx`, `simulate.py`를 작성합니다.',
      '3. source 상태가 `Ready`가 될 때까지 compile/evaluate 오류를 해결합니다.',
      '4. **Generate Candidate**로 `varsSchema` 범위의 새 변수 조건과 frozen Material 값을 미리 봅니다.',
      '5. 원하는 조건이면 **Save Current Measurement**로 변수와 Material snapshot을 고정합니다. 이 단계는 solver를 실행하지 않습니다.',
      '6. **Select Measurement**에서 prepared Measurement를 선택하거나 복제합니다.',
      '7. **Run Selected**로 선택한 prepared Measurement를 한 번 실행합니다.',
      '8. 성공하면 RecordedData가 원자적으로 기록되고 Measurement는 Recorded 상태가 됩니다. 결과 저장만 실패하면 세션 결과를 유지한 채 **Retry Saving Results**로 저장을 다시 시도합니다.',
      '',
      'Measurement는 immutable Experiment revision을 가리킵니다. 생성 요청의 source hash가 현재 revision과 다르면 저장이 거부되므로, source가 바뀌면 새 revision에서 새 Measurement를 준비하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'workbench-authoring-cycle',
    section: 'workbench',
    anchor: 'workbench-authoring-cycle',
    title: '편집, Candidate 생성과 실행 결과의 관계',
    summary: 'source 수정과 candidate 생성이 prepared·recorded Measurement에 미치는 영향을 설명합니다.',
    keywords: [
      'Dirty',
      'Checking',
      'Compiling',
      'Evaluating',
      'Resolving Materials',
      'Candidate',
      'Prepared',
      'Recorded',
    ],
    content: [
      'Source를 수정하면 `Dirty → Checking → Compiling → Evaluating → Resolving Materials → Ready` 순서로 검증됩니다. `Error`가 보이면 가장 먼저 diagnostics의 파일명과 line을 확인합니다.',
      '',
      '- **Source 수정**은 새 revision을 compile합니다.',
      '- **Generate Candidate**는 source를 바꾸지 않고 완전한 새 vars를 생성해 preview합니다.',
      '- Candidate는 저장 전까지 임시 상태이며 provenance나 seed 계약이 아닙니다.',
      '- **Save Current Measurement**는 현재 vars와 Material snapshot을 고정하지만 solver를 실행하지 않습니다.',
      '- 선택한 prepared Measurement만 실행할 수 있고, Recorded 상태가 된 Measurement는 다시 실행할 수 없습니다.',
      '',
      '새 조건으로 다시 계산하려면 기존 Measurement를 덮어쓰지 말고 복제하거나 새 Candidate를 저장하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'workbench-ai-helper',
    section: 'workbench',
    anchor: 'workbench-ai-helper',
    title: 'AI Helper에 질문하는 방법',
    summary: '현재 작업과 문서 근거를 활용해 재현 가능한 답을 받는 질문법입니다.',
    keywords: ['AI Helper', '질문', '코드 작성', 'reference context', '출처'],
    content: [
      'Help의 **AI Helper**는 이 문서와 catalog에서 질문에 관련된 부분을 찾아 현재 응답에만 참고자료로 붙입니다. 일반 Lab의 AI Chat과 대화 기록은 공유하지 않습니다.',
      '',
      '좋은 질문에는 다음 정보를 함께 적으세요.',
      '',
      '- 만들 물리 문제와 기대하는 RecordedData',
      '- 사용하려는 solver 또는 `methodId`',
      '- 오류 메시지와 발생 단계(compile, evaluate, candidate, Measurement run)',
      '- 유지해야 할 단위, Geometry group, Material 조건',
      '',
      'AI가 제안한 코드는 현재 catalog의 실제 key, unit, target과 일치하는지 확인하고 Workbench에서 `Ready`와 Measurement 실행으로 검증해야 합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'experiment-physical-model',
    section: 'program',
    anchor: 'experiment-physical-model',
    title: 'Experiment 공통 물리 모델의 책임',
    summary: 'experiment.tsx에서 geometry, vars, Material 역할 map, group과 결과 계약을 정의합니다.',
    keywords: ['Experiment', 'experiment()', 'TSX', 'lengthUnit', 'geometry', 'varsSchema'],
    content: [
      '`experiment.tsx`는 `@caemble/core`의 `experiment({...})`를 default export합니다. 여러 Task가 공유하는 물리 세계와 최종 결과 계약을 정의합니다.',
      '',
      '- `lengthUnit`: Geometry 숫자를 해석할 UCUM 길이 단위',
      '- `varsSchema`: Candidate로 생성할 scalar 또는 tensor 변수의 min/max',
      '- `geometry({ vars })`: 현재 vars로 만드는 Geometry tree',
      '- `geometryGroup`: solver가 참조할 Geometry ID 집합',
      '- `surfaceGroup`: `partId/surface-N` 형태의 surface 집합',
      '- `recordedData`: 성공한 실행이 한 번 기록할 최종 결과 schema',
      '',
      '모델 크기를 mm로 저작하더라도 solver 경계에서는 descriptor에 맞춰 단위가 변환됩니다. 숫자만 보고 SI라고 가정하지 말고 항상 `lengthUnit`과 각 DataSchema의 `unit`을 명시하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'experiment-vars-geometry',
    section: 'program',
    anchor: 'experiment-vars-geometry',
    title: 'vars, Geometry ID와 group 작성 규칙',
    summary: '재평가 가능한 변수와 안정적인 solver target을 만드는 규칙입니다.',
    keywords: ['varsSchema', 'Geometry', 'id', 'geometryGroup', 'surfaceGroup', 'target', 'tensor shape'],
    content: [
      '`varsSchema`의 `min`과 `max`는 같은 tensor shape를 가져야 합니다. Geometry callback은 `({ vars })`로 값을 받아야 하며 source 밖의 변경 가능한 상태에 의존하면 안 됩니다.',
      '',
      '모든 Geometry component 호출에는 같은 parent 아래에서 유일한 `id`를 부여하세요. 이 ID를 `geometryGroup`에 넣으면 task에서 `experiment.geometry.<group>`으로 참조할 수 있습니다. surface는 Viewer에서 확인한 안정적인 `partId/surface-N`을 `surfaceGroup`에 넣고 `experiment.surface.<group>`으로 참조합니다.',
      '',
      'Boolean operation의 자식 순서는 의미가 있습니다. 예를 들어 `<subtract>`의 첫 자식은 base이고 나머지는 cutter입니다. 정확한 prop과 문법은 [Geometry Catalog](/docs?section=geometry)를 사용하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'experiment-materials',
    section: 'program',
    anchor: 'experiment-materials',
    title: 'Material과 물성값 작성',
    summary: 'canonical material key, dtype, UCUM unit과 tensor shape를 올바르게 연결합니다.',
    keywords: ['Material', 'material.tsx', 'role map', 'body', 'Mat', 'canonical key', 'dtype', 'unit', 'errorRate'],
    content: [
      '`new Material(...)`은 `material.tsx`에서만 사용합니다. 이 파일은 named Material 객체 또는 Material을 반환하는 factory를 export하고, `experiment.tsx`와 Task는 이를 import해 root Geometry의 역할 map에 주입합니다.',
      '',
      '`materials`의 key는 `tire`, `wheel`, `shell` 같은 역할 이름입니다. primitive는 `body` 역할을 암묵적으로 소비합니다. child에서 `materials`를 생략하면 map 전체를 상속하고, 명시하면 교체하며 `{}`는 상속을 지웁니다. 중간 Geometry는 `materials={{ body: materials?.wheel }}`처럼 역할을 remap할 수 있습니다.',
      '',
      'Material property는 [Material Catalog](/docs?section=materials)의 canonical key를 사용합니다. 각 값에는 solver가 요구하는 `dtype`, UCUM `unit`, QuantityKind에 맞는 shape가 필요합니다.',
      '',
      '등방성 2차 tensor는 `Mat(value)`로 작성할 수 있습니다. 예를 들어 전기전도도는 `electrical.conductivity`, 열전도도는 `thermal.conductivity`입니다. 임의의 비슷한 이름을 새로 만들지 마세요.',
      '',
      '`errorRate`를 사용하면 새 Candidate의 frozen Material 값이 달라질 수 있습니다. Candidate 전체에서 이름과 선언이 같은 Material은 Experiment와 모든 Task를 통틀어 한 번만 sampling합니다. 같은 이름인데 선언이 다르면 오류입니다. 저장한 Measurement에는 실제 Material parameter snapshot이 고정됩니다.',
      '',
      'Viewer는 Material 또는 color가 없어도 canonical 역할 이름의 안정적인 hash 색을 사용합니다. unresolved 역할이 남은 preview와 Experiment 저장은 가능하지만 Measurement 생성과 solver 실행은 차단됩니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'experiment-verified-example',
    section: 'program',
    anchor: 'experiment-verified-example',
    title: `검증된 Experiment 예제: ${firstProgramExample.title}`,
    summary: 'production kernel fixture가 실제로 사용하는 통합 Experiment source입니다.',
    keywords: ['Experiment example', '검증된 예제', firstProgramExample.id, ...firstProgramExample.concepts],
    collapsed: true,
    content: [
      firstProgramExample.description,
      '',
      '```tsx',
      firstProgramExample.experimentSourceBundle.files['geometry.tsx'].trim(),
      '```',
      '',
      '```tsx',
      firstProgramExample.experimentSourceBundle.files['material.tsx'].trim(),
      '```',
      '',
      '```tsx',
      firstProgramExample.experimentSourceBundle.files['experiment.tsx'].trim(),
      '```',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-overview',
    section: 'program',
    anchor: 'experiment-program-overview',
    aliases: ['experiment-program-mental-model'],
    title: 'Experiment Program의 파일과 책임',
    summary: '공통 계약, named task와 Python orchestration을 독립 파일로 나눕니다.',
    keywords: [
      'Experiment Program',
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'tasks',
      'simulate.py',
      'orchestration',
      'formatVersion 5',
    ],
    content: [
      'Experiment Program은 공통 정의와 solver별 task, 실행 정책을 분리합니다.',
      '',
      '| 파일 | 책임 |',
      '| --- | --- |',
      '| `experiment.tsx` | 공통 lengthUnit, geometry, varsSchema, Material 역할 주입, group과 최종 recordedData 계약 |',
      '| `geometry.tsx` | Experiment와 Task가 공유하는 named Geometry component와 Published Geometry import |',
      '| `material.tsx` | named Material 객체 또는 vars를 받는 Material factory |',
      '| `tasks/<name>.tsx` | solver identity, 선택적 Task-local scene과 `config({ vars })` |',
      '| `simulate.py` | named task 실행 순서, 분기, artifact 전달·해제·기록 |',
      '',
      '공통 형상과 Task 보조 형상은 `geometry.tsx`, Material 정의는 `material.tsx`에서 named export하고 `experiment.tsx`와 각 Task에서 상대 import합니다. Task 사이의 중간 결과는 vars로 다시 계산하지 않고 typed artifact로 전달합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-material-role-example',
    section: 'program',
    anchor: 'experiment-program-material-roles',
    title: `Material 역할 예제: ${wheelAssemblyExample.title}`,
    summary: '하나의 Geometry에서 tire와 wheel을 상속하고 leaf의 body 역할로 remap합니다.',
    keywords: ['two materials', 'tire', 'wheel', 'body', 'inheritance', 'automatic color'],
    collapsed: true,
    content: [
      wheelAssemblyExample.description,
      '',
      '```tsx',
      wheelAssemblyExample.experimentSourceBundle.files['material.tsx'].trim(),
      '```',
      '',
      '```tsx',
      wheelAssemblyExample.experimentSourceBundle.files['geometry.tsx'].trim(),
      '```',
      '',
      '```tsx',
      wheelAssemblyExample.experimentSourceBundle.files['experiment.tsx'].trim(),
      '```',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-definition',
    section: 'program',
    anchor: 'experiment-program-definition',
    title: 'experiment.tsx: 변수와 RecordedData 계약',
    summary: '실험 공통 변수와 Measurement에 남길 최종 데이터만 선언합니다.',
    keywords: ['experiment()', 'varsSchema', 'recordedData', 'DataSchema', 'Measurement'],
    content: [
      '`experiment({...})`의 `recordedData`는 성공한 Measurement가 브라우저에 저장할 최종 schema입니다. task의 `outputs`는 이 계약이 아니라 kernel의 중간 artifact 요청입니다.',
      '',
      '각 RecordedData 항목에는 `dtype`, `unit`, `quantityKind`를 쓰고 다차원 값이면 축의 이름·단위·QuantityKind도 선언합니다. 성공 실행에서는 모든 declared key가 정확히 한 번 기록되어야 합니다. undeclared, duplicate 또는 missing record는 실행 오류입니다.',
      '',
      '```tsx',
      firstProgramExample.experimentSourceBundle.files['experiment.tsx'].trim(),
      '```',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-task',
    section: 'program',
    anchor: 'experiment-program-task',
    aliases: ['experiment-program-minimal-pair', 'experiment-program-kernel-limits', 'experiment-program-methods'],
    title: 'tasks/*.tsx: solver task 선언',
    summary: 'manifest의 parameter, method, target과 output 계약을 defineTask로 작성합니다.',
    keywords: ['defineTask', 'kernel', 'config', 'parameters', 'initializations', 'boundaryConditions', 'outputs'],
    content: [
      '`defineTask({...})`는 `kernel: { name, version }`, Task 전용 `lengthUnit`과 `geometry`, 그리고 `config({ vars })`를 선언합니다. Geometry를 사용하지 않아도 현재 계약에 맞는 scene과 단위를 명시하세요.',
      '',
      '`parameters`, `initializations`, `boundaryConditions`, `outputs`의 이름과 occurrence는 [Physics Catalog](/docs?section=solvers)의 현재 manifest가 단일 원본입니다. target은 `experiment.geometry.*`, `experiment.surface.*`, `task.geometry.*`, `task.surface.*` 중 method가 요구하는 source/kind와 일치해야 합니다.',
      '',
      '```tsx',
      Object.entries(firstProgramExample.experimentSourceBundle.files)
        .find(([path]) => path.startsWith('tasks/'))?.[1]
        .trim() ?? '',
      '```',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-simulate',
    section: 'program',
    anchor: 'experiment-program-simulate',
    title: 'simulate.py: 실행, 전달, 기록',
    summary: 'sim.run, sim.record, sim.release로 task와 artifact의 수명주기를 제어합니다.',
    keywords: ['simulate', 'sim.run', 'sim.record', 'sim.release', 'artifact', 'state', 'inputs'],
    content: [
      'Python `simulate(*, sim, tasks, vars)`가 named task의 실행 순서를 정합니다. `sim.run()`의 결과에는 opaque `state`, 다음 kernel에 전달하거나 기록할 `artifacts`, 작은 scalar `observations`가 있습니다.',
      '',
      '- `await sim.record(name, artifact)`: declared RecordedData로 승격하고 브라우저 ACK까지 대기',
      '- `sim.release(artifact)`: 더 사용하지 않는 중간 artifact 해제',
      '- `inputs={port: artifact}`: producer artifact를 호환되는 consumer input port에 전달',
      '- `state=...`: kernel의 opaque revision을 이어서 실행할 때만 사용',
      '',
      '```python',
      firstProgramExample.experimentSourceBundle.files['simulate.py'].trim(),
      '```',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-runtime-rules',
    section: 'program',
    anchor: 'experiment-program-runtime-rules',
    aliases: ['experiment-program-troubleshooting'],
    title: '실행 중 state와 artifact 규칙',
    summary: 'capability reference의 수명, rollback과 provisional RecordedData 규칙입니다.',
    keywords: ['state', 'artifact', 'rollback', 'provisional', 'ACK', 'fatal', 'release'],
    content: [
      'state와 artifact reference는 현재 run 안에서만 유효합니다. 다른 run의 ref, release한 artifact, 잘못된 schema나 격리 위반을 사용하면 전체 실행이 실패합니다.',
      '',
      'kernel call이 실패하면 해당 호출이 만든 state와 artifact를 함께 rollback합니다. `sim.record()`로 브라우저에 도착한 결과도 실행이 끝날 때까지 provisional이며, 뒤 Task나 Python orchestration이 실패하면 모두 폐기됩니다.',
      '',
      'time-series는 같은 이름을 반복 기록하지 말고 시간축이 있는 하나의 tensor artifact로 만드세요. 작은 반복 조건은 observation을 사용하고 큰 물리 데이터는 artifact로 전달합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-verified-examples',
    section: 'program',
    anchor: 'experiment-program-examples',
    title: '검증된 프로그램 예제 4종',
    summary: '실제 UI-CAE fixture로 검증되는 단계별 Experiment Program입니다.',
    keywords: ['program examples', 'DC', 'current density', 'resolution', 'electro thermal', 'multiphysics'],
    content: [
      '다음 예제는 문서 전용 복사본이 아니라 Workbench와 UI-CAE 계약 테스트가 사용하는 source bundle입니다.',
      '',
      ...caembleProgramExamples.flatMap((example) => [
        `### ${example.title}`,
        '',
        example.description,
        '',
        `핵심: ${example.concepts.join(', ')}`,
        '',
        `검증 RecordedData: ${example.verification.recordedData.map((name) => `\`${name}\``).join(', ')}`,
        '',
      ]),
    ].join('\n'),
  }),
  ...(multiphysicsExample
    ? [
        manualChunk({
          id: 'program-multiphysics-example',
          section: 'program',
          anchor: 'experiment-program-multiphysics',
          title: `Multiphysics 예제: ${multiphysicsExample.title}`,
          summary: 'DC의 Joule heating artifact를 정상상태 Heat task로 전달하는 검증된 orchestration입니다.',
          keywords: ['multiphysics', 'Joule heating', 'heatSource', 'electric', 'thermal'],
          collapsed: true,
          content: [
            multiphysicsExample.description,
            '',
            '```python',
            multiphysicsExample.experimentSourceBundle.files['simulate.py'].trim(),
            '```',
          ].join('\n'),
        }),
      ]
    : []),
  manualChunk({
    id: 'reference-source-import',
    section: 'reference',
    anchor: 'cad-reference-overview',
    aliases: ['cad-reference-source-import'],
    title: '공개 Source와 import 경계',
    summary: 'TSX source에서 사용할 수 있는 @caemble/core 공개 경계를 설명합니다.',
    keywords: ['CAD Reference', '@caemble/core', 'import', 'default export', 'compile', 'evaluate'],
    content: [
      '`material.tsx`는 `@caemble/core`만 import합니다. Experiment TSX는 `@caemble/core`, `./geometry`, `./material`, Task TSX는 `@caemble/core`, `../geometry`, `../material`의 named import만 사용합니다. Task 간 import, 동적 `import()`, `require()`, URL과 다른 package는 지원하지 않습니다.',
      '',
      'Experiment 정의는 `experiment({...})`, 각 Task는 `defineTask({...})`를 default export합니다. `material.tsx`는 named Material 객체 또는 factory만 export합니다. `geometry.tsx`와 Published Geometry module은 PascalCase named `Geometry<Props>` 함수 component를 여러 개 export할 수 있습니다. Geometry dependency는 exact coordinate의 named import 문이 유일한 원본이며 Tree와 DB projection은 source에서 자동으로 만들어집니다.',
      '',
      '```tsx',
      '// geometry.tsx',
      'import { NotchedConductor as Conductor } from "caemble:geometry/jlee/common/notched-conductor@1.2.3"',
      'export { Conductor }',
      '```',
      '',
      '```tsx',
      '// experiment.tsx',
      'import { Conductor } from "./geometry"',
      '<Conductor id="conductor" />',
      '```',
      '',
      'Geometry Manager의 **Experiment에서 사용**은 선택한 export의 exact import 예시를 복사하고 `geometry.tsx`를 엽니다. Source는 자동 수정하지 않습니다. Import alias는 해당 source module 안에서만 고유하며 `id` prop과는 별개입니다.',
      '',
      'Published node를 Tree에서 처음 수정하면 선택한 occurrence부터 `geometry.tsx`까지 필요한 module만 `@local` draft로 승격됩니다. Tree와 Viewer는 source import를 분석해 갱신되고, Geometry 또는 Experiment를 저장할 때 도달 가능한 local dependency를 child-first로 먼저 발행한 뒤 exact coordinate로 바꿉니다.',
      '',
      'Standalone preview는 선택한 named export를 `id="preview"`로 호출합니다. 첫 parameter의 구조 분해에서 직접 기본값을 제공한 custom prop은 호출 타입에서 optional로 추론됩니다. 기본값이 없는 prop과 `id`는 계속 필수입니다.',
      '',
      'Source revision은 compile한 뒤 명시적인 Candidate vars로 같은 compiled source를 다시 evaluate합니다. 브라우저나 Node 전역, 시간, 네트워크 같은 외부 상태에 의존하는 코드는 재현 가능한 Measurement를 만들 수 없습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-core-api',
    section: 'reference',
    anchor: 'cad-reference-core-api',
    aliases: ['cad-reference-primitives', 'cad-reference-operations', 'cad-reference-vars-geometry'],
    title: '@caemble/core 핵심 API',
    summary: 'CAE 저작에서 가장 자주 사용하는 공개 symbol의 책임을 정리합니다.',
    keywords: ['experiment', 'defineTask', 'Material', 'Mat', 'Geometry', 'Vec3', 'DataSchema'],
    content: [
      '| Symbol | 사용 위치 | 역할 |',
      '| --- | --- | --- |',
      '| `experiment` | `experiment.tsx` | 공통 geometry, vars, Material 역할 주입, group과 RecordedData schema 정의 |',
      '| `defineTask` | `tasks/*.tsx` | solver identity, Task scene과 config 정의 |',
      '| `Material` | `material.tsx` | canonical property와 sampling/freeze 정책 정의 |',
      '| `Mat` | Material tensor 값 | scalar를 등방성 3×3 tensor로 표현 |',
      '| `Geometry<Props>` | TSX component type | 재사용 가능한 Geometry component의 props 정의 |',
      '| `Vec3` | 위치·크기 props | 길이 3 vector type |',
      '',
      'Geometry element의 실제 tag와 prop syntax는 [Geometry Catalog](/docs?section=geometry), solver method와 parameter는 [Physics Catalog](/docs?section=solvers)를 사용하세요. catalog가 declaration과 manifest의 최신 단일 원본입니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-data-schema',
    section: 'reference',
    anchor: 'cad-reference-data-schema',
    aliases: ['cad-reference-material'],
    title: 'DataSchema, QuantityKind와 UCUM 단위',
    summary: 'scalar·tensor shape와 물리 의미, 변환 가능한 단위를 함께 선언합니다.',
    keywords: ['DataSchema', 'dtype', 'axes', 'shape', 'QuantityKind', 'UCUM', 'unit', 'tensorOrder'],
    content: [
      '물리 데이터는 값만 전달하지 않습니다. `dtype`, `unit`, `quantityKind`, 필요하면 `axes`가 함께 계약을 이룹니다.',
      '',
      '- scalar는 axes가 없습니다.',
      '- vector 또는 matrix의 component shape는 QuantityKind의 `tensorOrder`와 일치해야 합니다.',
      '- 공간장과 time-series의 sample 축은 `axes`에서 길이와 의미를 선언합니다.',
      '- unit은 [Quantity Catalog](/docs?section=quantity-kinds)의 `applicableUnits`에 있고 worker가 변환할 수 있는 UCUM 문자열이어야 합니다.',
      '- `{fraction}`처럼 중괄호가 있는 UCUM annotation도 문자열 그대로 사용합니다.',
      '',
      'Material catalog에 key가 존재한다는 사실만으로 임의 unit이 허용되는 것은 아닙니다. Material의 QuantityKind와 실제 worker unit converter 계약을 모두 만족해야 합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-targets-results',
    section: 'reference',
    anchor: 'cad-reference-targets-results',
    aliases: ['cad-reference-task-recorded-data', 'cad-reference-kernels', 'cad-reference-results'],
    title: 'Target, run 상태와 결과 경계',
    summary: 'Experiment/Task scene target과 RecordedData가 worker 경계를 통과하는 방식을 설명합니다.',
    keywords: ['target', 'experiment.geometry', 'task.geometry', 'run status', 'RecordedData', 'trace', 'provenance'],
    content: [
      'target 문자열은 `<scene>.<kind>.<group>` 형태입니다. `experiment.*`는 공통 물리 scene, `task.*`는 현재 named Task의 local scene을 가리킵니다. method manifest의 `source`와 `kind`가 target과 일치해야 합니다.',
      '',
      'Prepared Measurement는 고정 입력 조건이며 그 자체가 실행 상태를 갖는 run은 아닙니다. 선택한 Measurement로 시작한 실행 요청이 성공, 실패 또는 취소로 끝나고, 성공 결과를 한 번 저장하면 Measurement가 Recorded 상태가 됩니다. opaque solver state와 중간 artifact는 CAE worker 밖으로 나오지 않습니다. 브라우저는 Experiment에 선언되고 `sim.record()`가 완료된 RecordedData만 받습니다. trace와 provenance는 진단용이며 사용자 결과 schema에 자동 추가되지 않습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'troubleshooting-ready',
    section: 'troubleshooting',
    anchor: 'troubleshooting-ready',
    title: '문서가 Ready가 되지 않을 때',
    summary: 'compile/evaluate 단계와 source 위치를 기준으로 오류를 좁힙니다.',
    keywords: ['troubleshooting', 'Ready', 'compile', 'evaluate', 'diagnostic', 'source error'],
    content: [
      '1. diagnostics에 표시된 **파일명, line, column과 첫 오류**부터 확인합니다.',
      '2. import가 `@caemble/core`인지, 올바른 default export를 사용하는지 확인합니다.',
      '3. TSX tag와 prop 이름을 Geometry Catalog의 syntax와 비교합니다.',
      '4. `varsSchema` min/max shape, Geometry ID 중복과 group member ID를 확인합니다.',
      '5. Material key, dtype, unit과 tensor shape를 catalog와 비교합니다.',
      '',
      'source를 고친 뒤에도 이전 조건만 보인다면 상태가 `Ready`인지 확인하고 새 Candidate를 생성합니다. 이전 Experiment revision의 Measurement는 현재 revision에서 실행할 수 없습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'troubleshooting-target-manifest',
    section: 'troubleshooting',
    anchor: 'troubleshooting-target-manifest',
    title: 'target 또는 solver manifest 오류',
    summary: 'solver identity, method occurrence와 group target을 현재 manifest에 맞춥니다.',
    keywords: ['target', 'manifest', 'methodId', 'occurrence', 'group', 'solver', 'invalid_manifest'],
    content: [
      '- Physics Catalog에서 `name@version`이 정확히 존재하는지 확인합니다.',
      '- method가 `initializations`, `boundaryConditions`, `outputs` 중 어디에 속하는지 확인합니다.',
      '- required parameter와 occurrence의 최소·최대 횟수를 확인합니다.',
      '- target의 scene(`experiment`/`task`)과 kind(`geometry`/`surface`)를 확인합니다.',
      '- group 이름이 source에 선언되어 있고 실제 Geometry 또는 surface로 resolve되는지 확인합니다.',
      '',
      'solver manifest 내용을 UI에 복사해 고치지 마세요. 배포된 manifest와 [Physics Catalog](/docs?section=solvers)가 현재 계약입니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'troubleshooting-units-materials',
    section: 'troubleshooting',
    anchor: 'troubleshooting-units-materials',
    title: 'unit, QuantityKind 또는 Material 오류',
    summary: 'canonical key와 변환 가능한 UCUM 단위, tensor shape를 함께 점검합니다.',
    keywords: ['invalid_unit', 'UCUM', 'QuantityKind', 'Material', 'tensor', 'conductivity'],
    content: [
      '1. Material key를 Material Catalog에서 정확히 복사합니다.',
      '2. 그 key가 가리키는 QuantityKind를 확인합니다.',
      '3. Quantity Catalog에서 현재 unit이 `applicableUnits`에 있는지 확인합니다.',
      '4. solver parameter가 요구하는 QuantityKind와 dtype을 Physics Catalog에서 확인합니다.',
      '5. vector/matrix 값의 shape와 basis 조건을 확인합니다.',
      '',
      '`invalid_unit`은 이름이 그럴듯한 단위라도 worker가 해당 QuantityKind에 대해 변환할 수 없다는 뜻입니다. catalog membership 하나만 보고 새 단위를 추가하지 마세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'troubleshooting-runtime-results',
    section: 'troubleshooting',
    anchor: 'troubleshooting-runtime-results',
    title: 'Measurement 실행 또는 결과 오류',
    summary: '선택 입력, artifact 수명과 RecordedData 계약을 순서대로 점검합니다.',
    keywords: ['Measurement', 'artifact', 'recordedData', 'stale', 'failed', 'cancelled', 'Launcher'],
    content: [
      '1. 로그인과 CAE Launcher 연결 상태를 확인합니다.',
      '2. 현재 Experiment revision에 속하고 RecordedData가 아직 없는 prepared Measurement를 선택했는지 확인합니다.',
      '3. Python의 task 이름이 `tasks/<name>.tsx` 파일명과 일치하는지 확인합니다.',
      '4. output key와 `result["artifacts"]` key를 확인합니다.',
      '5. `sim.record()` 이름과 Experiment `recordedData` 이름을 확인합니다.',
      '6. release한 artifact를 다시 전달하거나 기록하지 않았는지 확인합니다.',
      '7. source를 수정했다면 stale 결과를 버리고 다시 실행합니다.',
      '',
      '취소는 정상적인 terminal 상태일 수 있습니다. 실패 원인을 분석할 때는 사용자에게 보이는 첫 오류와 현재 task/method를 함께 기록하고, opaque worker state나 전체 binary 결과를 복사하지 마세요.',
    ].join('\n'),
  }),
])

export const catalogDocsKnowledge: readonly DocsKnowledgeChunk[] = Object.freeze([
  ...cadElementCatalog.map((entry) =>
    Object.freeze({
      id: `geometry:${entry.tag}`,
      section: 'geometry' as const,
      title: entry.tag,
      summary: entry.summary,
      item: entry.tag,
      href: docsSectionHref('geometry', entry.tag),
      keywords: Object.freeze([entry.tag, entry.category, entry.syntax]),
      content: [`Category: ${entry.category}`, `Syntax: ${entry.syntax}`, entry.summary].join('\n'),
    }),
  ),
])

export function catalogSearchKnowledge(items: readonly CatalogSearchItem[]): readonly DocsKnowledgeChunk[] {
  return Object.freeze(items.map((item) => {
    const section = item.kind === 'quantityKind' ? 'quantity-kinds' : item.kind === 'solver' ? 'solvers' : 'materials'
    return Object.freeze({
      id: `${item.kind}:${item.key}`,
      section,
      title: item.title,
      summary: item.subtitle,
      item: item.key,
      href: docsSectionHref(section, item.key),
      keywords: Object.freeze([item.kind, item.key, item.title, item.subtitle]),
      content: item.subtitle,
    })
  }))
}

export function getDocsKnowledge(): readonly DocsKnowledgeChunk[] {
  return [...manualDocsKnowledge, ...catalogDocsKnowledge]
}

export function searchDocsKnowledge(
  query: string,
  chunks: readonly DocsKnowledgeChunk[] = getDocsKnowledge(),
): readonly DocsKnowledgeChunk[] {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase()
  if (!needle) return []
  const terms = needle.split(/\s+/).filter(Boolean)

  return chunks
    .flatMap((chunk) => {
      const title = chunk.title.normalize('NFKC').toLocaleLowerCase()
      const normalizedKeywords = chunk.keywords.map((keyword) => keyword.normalize('NFKC').toLocaleLowerCase())
      const keywords = normalizedKeywords.join(' ')
      const text = `${title} ${chunk.summary} ${keywords}${chunk.item ? ` ${chunk.content}` : ''}`
        .normalize('NFKC')
        .toLocaleLowerCase()
      const matchedTerms = terms.filter((term) => text.includes(term)).length
      if (!text.includes(needle) && matchedTerms === 0) return []
      const rank =
        title === needle
          ? 0
          : title.startsWith(needle)
            ? 1
            : normalizedKeywords.some((keyword) => keyword === needle)
              ? 2
              : normalizedKeywords.some((keyword) => keyword.startsWith(needle))
                ? 3
                : text.includes(needle)
                  ? 4
                  : 5
      return [{ chunk, matchedTerms, rank }]
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.matchedTerms - left.matchedTerms ||
        left.chunk.title.localeCompare(right.chunk.title, 'ko') ||
        left.chunk.id.localeCompare(right.chunk.id),
    )
    .map(({ chunk }) => chunk)
}
