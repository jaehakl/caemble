import type { CatalogSearchItem } from '@/api/catalog'
import { cadElementCatalog } from '@/lib/cad'
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
      '2. 상단 **Experiment** 메뉴를 선택하고 왼쪽 목록에서 Example 또는 저장된 namespace / repository / SemVer Version을 연 뒤, 오른쪽 Source 탭에서 source bundle을 작성합니다.',
      '3. source 상태가 `Ready`가 될 때까지 compile/evaluate 오류를 해결합니다.',
      '4. **Generate Candidate**로 `varsSchema` 범위의 새 변수 조건과 frozen Material 값을 미리 봅니다.',
      '5. 원하는 조건이면 **Save Current Measurement**로 변수와 Material snapshot을 고정합니다. 이 단계는 solver를 실행하지 않습니다.',
      '6. 상단 **Measurement** 메뉴의 왼쪽 점 배열에서 prepared Measurement를 선택합니다. Ctrl/Cmd+클릭으로 여러 항목을 선택하고 Shift+클릭으로 현재 페이지의 범위를 선택할 수 있습니다.',
      '7. **Generate & Run**은 클릭할 때마다 새 Candidate를 생성하고 새 Measurement로 저장한 뒤 즉시 실행합니다. Candidate 생성이나 저장 단계는 취소할 수 없고, Simulation이 시작된 뒤에는 Cancel할 수 있습니다.',
      '8. 횟수를 입력하고 **Repeat Run**을 누르면 Generate & Run 파이프라인을 순차적으로 N회 시도합니다. 기본값은 10이며, N은 성공 횟수가 아니라 전체 시도 횟수입니다.',
      '9. Repeat Run은 Candidate 평가, Measurement 준비 또는 Simulation이 실패한 시도를 집계하고 다음 시도를 계속합니다. 결과 저장 실패나 명시적 Cancel은 남은 반복을 중단하며, 저장 실패 결과는 **Retry Saving Results**로 다시 저장할 수 있습니다.',
      '10. 기존 prepared Measurement를 실행하려면 **Run Selected**를 사용합니다. Generate & Run 실행이 실패하거나 취소되어도 새 Measurement는 Prepared 상태로 남습니다.',
      '11. 성공하면 RecordedData가 원자적으로 기록되고 Measurement는 Recorded 상태가 됩니다. 결과 저장만 실패하면 세션 결과를 유지한 채 **Retry Saving Results**로 저장을 다시 시도합니다.',
      '',
      'Measurement는 immutable Experiment revision을 가리킵니다. 생성 요청의 source hash가 현재 revision과 다르면 저장이 거부되므로, source가 바뀌면 새 revision에서 새 Measurement를 준비하세요.',
      '',
      'Task 파일이 하나도 없는 Experiment도 Geometry preview와 Experiment 저장은 사용할 수 있습니다. 이 경우 Measurement 생성·선택·분석과 Simulation 실행은 Task를 추가할 때까지 비활성화됩니다.',
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
      '새 조건으로 다시 계산하려면 기존 Measurement를 덮어쓰지 말고 새 Candidate를 생성한 뒤 새 Measurement로 저장하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'workbench-analysis',
    section: 'workbench',
    anchor: 'workbench-analysis',
    title: 'Analysis: Explore, Mining, Prediction과 Data',
    summary: 'Recorded Measurement를 탐색하고 고급 분석과 CSV 내보내기를 사용하는 방법입니다.',
    keywords: ['Analysis', 'Explore', 'Pearson', 'Spearman', 'Mining', 'PCA', 'Prediction', 'What-if', 'CSV'],
    content: [
      '**Analysis**는 현재 Experiment의 Measurement와 Recorded Data를 브라우저 Worker 메모리에서만 분석합니다. 중앙 3D Viewer와 Console은 그대로 유지되며, 오른쪽 Analysis 결과와 왼쪽 탭별 설정은 각각 스크롤할 수 있습니다.',
      '',
      '### Explore',
      '',
      'Analysis에 들어오면 사용할 수 있는 숫자 input vars와 숫자 Recorded Data의 모든 조합을 계산합니다. Material parameter는 기본 상관 순위에 포함하지 않습니다. `|Pearson r|`이 큰 순서로 정렬하고, 같으면 `|Spearman ρ|`와 안정적인 key 순서를 사용합니다. 1위 조합이 자동으로 선택되며 검색 가능한 두 선택기나 순위 행으로 다른 조합을 고를 수 있습니다.',
      '',
      'Pearson과 Spearman은 완전한 input/target 값 쌍이 3개 이상이고 두 축이 상수가 아닐 때만 계산합니다. `n`은 실제 계산에 사용한 완전한 쌍의 수입니다. 산점도의 점에 포인터를 올리면 Measurement ID와 좌표를 확인할 수 있습니다.',
      '',
      '### Mining과 Prediction',
      '',
      '**Mining**은 2–50개 feature를 표준화해 PCA projection, 자동 K-Means, principal-component loadings와 reconstruction anomaly를 계산합니다. Explore 선택과는 독립적이며 검색, source 그룹, 전체 선택과 초기화를 사용할 수 있습니다.',
      '',
      '**Prediction**은 target이 있는 행 20개 이상, 서로 다른 target 값 5개 이상, target이 존재하는 서로 다른 입력 5개 이상이어야 활성화됩니다. 동일 입력을 fold 사이에 분리한 OOF 검증으로 Ridge와 Random Forest를 비교한 뒤 선택 모델, OOF 지표, 관측값 대 예측값, feature importance를 표시합니다. 첫 학습 뒤 What-if는 교차 검증이나 재학습 없이 Worker에 캐시된 최종 모델로만 다시 계산합니다.',
      '',
      '### Data와 CSV',
      '',
      '**Data**에는 histogram, scalar profile, categorical 빈도와 100행 데이터 표가 있습니다. 표와 **선택 데이터 CSV**는 Data 설정에서 선택한 열만 사용합니다. **Prediction CSV**는 마지막으로 완료된 학습의 OOF 결과를 내보내며, What-if 입력만 바꿔도 학습 행 자체는 바뀌지 않습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'workbench-ai-helper',
    section: 'workbench',
    anchor: 'workbench-ai-helper',
    title: 'AI Agent에 질문하는 방법',
    summary: '현재 작업과 문서 근거를 활용해 재현 가능한 답을 받는 질문법입니다.',
    keywords: ['AI Agent', '질문', '코드 작성', 'reference context', '출처', '하단 Dock'],
    content: [
      '중앙 하단 Dock의 **AI Agent**는 이 문서와 catalog에서 질문에 관련된 부분을 찾아 현재 응답에만 참고자료로 붙입니다. 일반 Lab의 AI Chat과 대화 기록은 공유하지 않습니다.',
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
    id: 'program-overview',
    section: 'program',
    anchor: 'experiment-program-overview',
    aliases: ['experiment-program-mental-model', 'experiment-physical-model'],
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
      'formatVersion 6',
    ],
    content: [
      'Experiment Program은 공통 정의와 solver별 task, 실행 정책을 분리합니다.',
      '',
      '| 파일 | 책임 |',
      '| --- | --- |',
      '| `experiment.tsx` | 공통 lengthUnit, geometry, varsSchema, Material 역할 주입, group과 최종 recordedData 계약 |',
      '| `geometry.tsx` | Experiment와 Task가 공유하는 named Geometry component |',
      '| `material.tsx` | named Material 객체 또는 vars를 받는 Material factory |',
      '| `tasks/<name>.tsx` | solver identity, 선택적 Task-local scene과 `config({ vars })` |',
      '| `simulate.py` | named task 실행 순서, 분기, artifact 전달·해제·기록 |',
      '| 그 밖의 `.ts`, `.tsx` 파일 | bundle 내부에서 상대 import하는 보조 모듈 |',
      '',
      '공통 형상과 Task 보조 형상은 `geometry.tsx`, Material 정의는 `material.tsx`에서 named export하고 `experiment.tsx`와 각 Task에서 상대 import합니다. 필요한 보조 코드는 bundle에 파일을 추가해 로컬 상대 import할 수 있습니다. Source bundle 밖 package, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.',
      '',
      '`experiment.tsx`의 `lengthUnit`, `varsSchema`, `geometry({ vars })`, `geometryGroup`, `surfaceGroup`, `recordedData`가 여러 Task가 공유하는 물리 세계와 최종 결과 계약입니다. 숫자만 보고 SI라고 가정하지 말고 scene 길이 단위와 각 DataSchema의 UCUM 단위를 명시하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-definition',
    section: 'program',
    anchor: 'experiment-program-definition',
    aliases: ['experiment-vars-geometry'],
    title: 'experiment.tsx: 변수와 RecordedData 계약',
    summary: '실험 공통 변수와 Measurement에 남길 최종 데이터만 선언합니다.',
    keywords: ['experiment()', 'varsSchema', 'recordedData', 'DataSchema', 'Measurement'],
    content: [
      '`experiment({...})`의 `recordedData`는 성공한 Measurement가 브라우저에 저장할 최종 schema입니다. task의 `outputs`는 이 계약이 아니라 kernel의 중간 artifact 요청입니다.',
      '',
      '각 RecordedData 항목에는 `dtype`, `unit`, `quantityKind`를 쓰고 다차원 값이면 축의 이름·단위·QuantityKind도 선언합니다. 성공 실행에서는 모든 declared key가 정확히 한 번 기록되어야 합니다. undeclared, duplicate 또는 missing record는 실행 오류입니다.',
      '',
      '`varsSchema`의 각 항목은 `{ shape, min, max }` 세 필드만 사용합니다. scalar는 `shape: []`, tensor는 `[3]`, `[4, 4, 1]`처럼 양의 safe integer 차원을 명시합니다. `min`과 `max`는 tensor가 아니라 모든 원소에 공통 적용되는 finite scalar이고 `min <= max`여야 합니다. shape 전체 원소 수는 65,536개 이하여야 하며 shape 추론과 scalar/tensor broadcast는 지원하지 않습니다.',
      '',
      '```tsx',
      'varsSchema: {',
      '  radius: { shape: [], min: 2, max: 5 },',
      '  position: { shape: [3], min: -10, max: 10 },',
      '}',
      '```',
      '',
      'Candidate는 선언한 shape와 정확히 같은 dense rectangular numeric tensor여야 합니다. 축별 범위가 다르면 `positionX`, `positionY`, `positionZ`처럼 의미별 scalar 변수로 분리한 뒤 Geometry callback에서 다시 조합하세요. Geometry callback은 `({ vars })`로 값을 받고 외부의 변경 가능한 상태에 의존하지 않아야 합니다. 같은 parent 아래의 component `id`는 고유해야 하며, 이 ID를 `geometryGroup`에 넣어 `experiment.geometry.<group>`으로 참조합니다. CAD API v10의 surface member는 `<geometry-id>/surface/<URL-encoded-face-key>` 형식이며 Viewer와 Geometry Catalog의 semantic face key를 사용합니다.',
      '',
      '[DC Uniform Bar의 canonical experiment.tsx 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-uniform-bar@2.0.0)',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-materials',
    section: 'program',
    anchor: 'experiment-program-materials',
    aliases: ['experiment-materials', 'experiment-program-material-roles'],
    title: 'Material 역할과 물성값',
    summary: 'canonical property와 역할 map을 선언하고 leaf의 body 역할로 연결합니다.',
    keywords: [
      'Material',
      'material.tsx',
      'role map',
      'body',
      'Mat',
      'canonical key',
      'dtype',
      'unit',
      'errorRate',
      'tire',
      'wheel',
    ],
    content: [
      '`new Material(...)`은 `material.tsx`에서만 사용합니다. named Material 객체 또는 factory를 export하고 Experiment와 Task는 이를 import해 root Geometry의 역할 map에 주입합니다.',
      '',
      '`materials` key는 `tire`, `wheel`, `shell` 같은 역할 이름입니다. primitive는 `body` 역할을 소비합니다. child에서 `materials`를 생략하면 map을 상속하고, 명시하면 교체하며, `{}`는 상속을 지웁니다. 중간 Geometry는 `materials={{ body: materials?.wheel }}`처럼 역할을 remap할 수 있습니다.',
      '',
      'Property는 [Material Catalog](/docs?section=materials)의 canonical key를 사용하고 solver가 요구하는 `dtype`, UCUM `unit`, QuantityKind와 tensor shape를 맞춥니다. 등방성 2차 tensor는 `Mat(value)`로 표현할 수 있습니다.',
      '',
      '`errorRate`가 있으면 Candidate의 frozen 값이 달라질 수 있습니다. 같은 이름과 선언의 Material은 Experiment와 모든 Task에서 한 번만 sampling되며, 저장한 Measurement에는 실제 parameter snapshot이 고정됩니다. unresolved 역할은 preview할 수 있지만 Measurement 생성과 solver 실행은 차단됩니다.',
      '',
      '[Two-material Wheel Assembly의 canonical Experiment bundle 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/assemblies/two-material-wheel-assembly@1.0.0)',
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
      '[DC Uniform Bar의 canonical Task source 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-uniform-bar@2.0.0)',
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
      '[DC Uniform Bar의 canonical simulate.py 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-uniform-bar@2.0.0)',
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
    aliases: ['experiment-verified-example'],
    title: '검증된 Examples',
    summary: '실제 UI-CAE fixture로 검증되는 단계별 Experiment Program입니다.',
    keywords: ['program examples', 'DC', 'current density', 'resolution', 'electro thermal', 'multiphysics'],
    content: [
      '다음 Examples는 SQLite 카탈로그의 source bundle을 Workbench와 UI-CAE 계약 테스트가 직접 사용합니다.',
      '',
      '- [DC Uniform Bar](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-uniform-bar@2.0.0)',
      '- [DC Notched Current Density](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-notched-current-density@2.0.0)',
      '- [DC Resolution Study](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/dc-resolution-study@2.0.0)',
      '- [Electro-Thermal Uniform Bar](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/electro-thermal-uniform-bar@2.0.0)',
      '- [Basketball Goal](/docs?section=solvers&item=experiment:caemble:experiment/caemble/getting-started/basketball-goal@1.0.0)',
      '- [Fiber Bundle](/docs?section=solvers&item=experiment:caemble:experiment/caemble/advanced-shapes/fiber-bundle@1.0.0)',
      '- [Shell Cutaways](/docs?section=solvers&item=experiment:caemble:experiment/caemble/advanced-shapes/shell-cutaways@1.0.0)',
      '- [Random Curved-edge Cylinder Array](/docs?section=solvers&item=experiment:caemble:experiment/caemble/arrays/random-curved-edge-cylinder-array@1.0.0)',
      '- [Random Curved-surface Sphere HCP Array](/docs?section=solvers&item=experiment:caemble:experiment/caemble/arrays/random-curved-surface-sphere-hcp-array@1.0.0)',
      '- [Geometry Authoring Skeleton](/docs?section=solvers&item=experiment:caemble:experiment/caemble/getting-started/geometry-authoring-skeleton@1.0.0)',
      '- [Two-material Wheel Assembly](/docs?section=solvers&item=experiment:caemble:experiment/caemble/assemblies/two-material-wheel-assembly@1.0.0)',
    ].join('\n'),
  }),
  manualChunk({
    id: 'program-multiphysics-example',
    section: 'program',
    anchor: 'experiment-program-multiphysics',
    title: 'Multiphysics 예제: Electro-Thermal Uniform Bar',
    summary: 'DC의 Joule heating artifact를 정상상태 Heat task로 전달하는 검증된 orchestration입니다.',
    keywords: ['multiphysics', 'Joule heating', 'heatSource', 'electric', 'thermal'],
    collapsed: true,
    content:
      '[Electro-Thermal Uniform Bar의 canonical bundle과 verification 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/electro-thermal-uniform-bar@2.0.0)',
  }),
  manualChunk({
    id: 'reference-source-import',
    section: 'reference',
    anchor: 'cad-reference-overview',
    aliases: ['cad-reference-source-import'],
    title: '공개 Source와 import 경계',
    summary: 'TSX source에서 사용할 수 있는 @caemble/core 공개 경계를 설명합니다.',
    keywords: ['CAD Reference', '@caemble/core', 'import', 'default export', 'compile', 'evaluate'],
    content: [
      'Experiment source bundle은 핵심 파일뿐 아니라 사용자가 추가한 로컬 `.ts`, `.tsx` 파일도 함께 저장합니다. TypeScript/TSX 파일은 bundle 안의 다른 파일을 상대 경로로 import할 수 있습니다. Python은 핵심 `simulate.py` 한 파일만 사용합니다. `@caemble/core` 외 package, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.',
      '',
      'Experiment 정의는 `experiment({...})`, 각 Task는 `defineTask({...})`를 default export합니다. `material.tsx`는 named Material 객체 또는 factory를 export하고, `geometry.tsx`는 PascalCase named `Geometry<Props>` 함수 component를 여러 개 export할 수 있습니다. 모든 의존 코드는 같은 Experiment bundle 안에 있으므로 별도 Geometry Repository나 Version coordinate를 해석하지 않습니다.',
      '',
      '부분 예시 — 다음 fence는 완성 파일이 아니라 로컬 bundle import 경계만 보여줍니다.',
      '',
      '```tsx',
      '// geometry.tsx',
      'import { profilePoints } from "./lib/profile"',
      'export const Conductor: Geometry = () => <Polygon points={profilePoints} />',
      '```',
      '',
      'Experiment Manager는 Example과 저장된 사용자 Experiment Version을 엽니다. 저장된 coordinate는 `namespace / repository / key / SemVer`로 식별하며, Repository는 별도 관리 객체가 아니라 저장된 Experiment에서 파생되는 그룹입니다.',
      '',
      '**Save**는 현재 Version을 덮어쓰고, **Save New Version**은 patch/minor/major를 증가시키며, **Save As**는 새 repository/key의 `0.1.0`을 만듭니다. Measurement나 모델이 연결된 Version은 source만 잠깁니다. source 변경은 새 Version 또는 Save As로 저장하되, name/description 같은 metadata는 현재 Version에 **Save**할 수 있습니다.',
      '',
      'Standalone preview는 선택한 named export를 props 없이 호출할 수 있습니다. 모든 local PascalCase `Geometry<Props>` 함수는 custom prop을 직접 구조 분해하고 각각 명시적인 기본값을 제공해야 합니다. `id`, Material, children과 transform은 evaluator가 공통 기본값을 주입합니다.',
      '',
      'Source revision은 compile한 뒤 명시적인 Candidate vars로 같은 compiled source를 다시 evaluate합니다. 브라우저나 Node 전역, 시간, 네트워크 같은 외부 상태에 의존하는 코드는 재현 가능한 Measurement를 만들 수 없습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-geometry-skeleton',
    section: 'reference',
    anchor: 'cad-reference-geometry-skeleton',
    title: 'Geometry 저작 골격과 좌표계',
    summary: 'CAD API v10 source의 기본 구조, 필수 prop 기본값, PascalCase primitive와 제어문 활용을 함께 보여줍니다.',
    keywords: [
      'CAD API v10',
      'geometry.tsx',
      'Geometry',
      'PascalCase',
      'loop',
      'control flow',
      'right-handed',
      'lengthUnit',
      '좌표계',
    ],
    content: [
      'CAD API v10 Geometry는 JSX를 반환하는 순수 함수 component입니다. `geometry.tsx`에는 재사용할 named `Geometry<Props>`를 두고, `experiment.tsx`의 `geometry` callback에서 호출합니다. 모든 custom prop은 required/optional 표기와 관계없이 구조 분해 initializer가 있어야 하므로 `<Assembly />`처럼 props 없이 호출할 수 있습니다. 숫자로 된 길이는 모두 해당 scene의 `lengthUnit`으로 해석됩니다.',
      '',
      '[AI Agent가 사용하는 canonical Geometry Authoring Skeleton Experiment 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/getting-started/geometry-authoring-skeleton@1.0.0)',
      '',
      '이 skeleton은 SQLite 카탈로그에서 AI reference로 생성되며 production과 동일한 TypeScript emit 설정, declaration type-check와 실제 evaluator 회귀 테스트를 통과합니다.',
      '',
      '좌표계는 오른손 좌표계입니다. `+X`, `+Y`, `+Z`와 회전의 양의 방향에는 오른손 법칙을 적용합니다. primitive의 기준축과 원점은 요소마다 다르므로 추측하지 말고 [Geometry Catalog](/docs?section=geometry)의 **Origin / surfaces**를 확인하세요. 예를 들어 기본 cylinder 축은 Z이고, box와 cylinder는 자신의 local origin을 중심으로 생성됩니다.',
      '',
      'component는 입력 props와 `vars`만으로 같은 tree를 만들어야 합니다. 시간, 난수, DOM, 네트워크나 변경 가능한 module 상태에 의존하면 같은 source와 Measurement를 재현할 수 없습니다.',
      '',
      'Primitive는 props를 생략하면 Catalog에 표시된 canonical 단위 형상 기본값을 사용합니다. 자동 ID는 authoring name의 lower-kebab과 sibling 순번(`box`, `box-2`)으로 정해집니다.',
      '',
      '`for`, `Array.from`/`map`, `if`와 조건부 JSX를 사용할 수 있습니다. 반복 횟수는 유한하고 입력으로 재현 가능해야 하며, 반복되는 sibling에는 삽입·재정렬에도 유지되는 index나 domain key 기반의 명시적 `id`를 만드세요. 규칙적인 격자는 JS loop보다 `array` operation을 우선합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-geometry-transforms',
    section: 'reference',
    anchor: 'cad-reference-geometry-transforms',
    aliases: ['cad-reference-v7-migration'],
    title: 'Transform: direct props와 operation wrapper',
    summary: 'direct Euler prop과 계층적인 translate·rotate·scale wrapper를 구분해 사용합니다.',
    keywords: [
      'position',
      'rotation',
      'scale',
      'translate',
      'axis angle',
      'radians',
      'Euler',
      'transform order',
      'pos',
      'rotate',
    ],
    content: [
      'Primitive, Boolean·shell·array operation과 `Geometry` component 호출은 같은 direct transform 계약을 사용합니다. `translate`·`rotate`·`scale` wrapper는 별도의 전용 prop 계약을 사용합니다.',
      '',
      '| Prop | 형식 | 의미 |',
      '| --- | --- | --- |',
      '| `position` | `[x, y, z]` | parent 좌표계에서의 이동 |',
      '| `rotation` | `[x, y, z]` | radian 단위의 intrinsic XYZ Euler, `THREE.Euler(x, y, z, "XYZ")`와 같은 의미 |',
      '| `scale` | `[x, y, z]` | 축별 배율. 균일 배율은 세 값을 같게 작성 |',
      '',
      '한 node 안에서는 **scale → rotation → position** 순서로 적용됩니다. parent와 child transform은 tree 계층대로 합성됩니다. 각도는 degree가 아니라 radian이므로 `Math.PI / 2`처럼 작성하세요.',
      '',
      '부분 예시 — 아래 fence는 완성 파일이 아닌 단일 intrinsic element 식입니다.',
      '',
      '```tsx',
      '<Cylinder',
      '  id="arm"',
      '  radius={2.5}',
      '  height={200}',
      '  position={[0, 100, 298]}',
      '  rotation={[Math.PI / 2, 0, 0]}',
      '/>',
      '```',
      '',
      '여러 child를 한 local transform 아래 묶을 때는 lowercase operation wrapper를 사용합니다. Wrapper는 아래 전용 prop만 받고 direct transform prop과 섞지 않습니다. 안쪽 wrapper부터 적용되므로 다음 순서는 scale → rotate → translate입니다.',
      '',
      '```tsx',
      "import { Box, radians } from '@caemble/core'",
      '',
      '<translate offset={[100, 0, 0]}>',
      '  <rotate axis={[0, 0, 1]} angle={radians(90)}>',
      '    <scale x={2} y={1} z={1}>',
      '      <Box id="body" size={[20, 10, 5]} />',
      '    </scale>',
      '  </rotate>',
      '</translate>',
      '```',
      '',
      '`radians(number)`와 `radians(Vec3)`는 degree를 radian으로 바꿉니다. Direct `rotation`은 intrinsic XYZ Euler Vec3이고, `<rotate>`는 오른손 법칙의 axis-angle이므로 두 표현의 의미를 구분하세요.',
      '',
      '`pos`와 `{ axis, angle }` 형태의 `rotate`는 v7 안에서 기존 source를 잠시 옮기기 위한 deprecated 호환 문법입니다. 새 코드는 `position`과 `rotation`만 사용하세요. 같은 node에서 canonical family와 deprecated family를 섞을 수 없으며 `translation` prop은 지원하지 않습니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-geometry-identity',
    section: 'reference',
    anchor: 'cad-reference-geometry-identity',
    title: 'ID, group과 surface identity',
    summary: '안정적인 solver target을 위해 component, primitive와 operation의 소유권을 구분합니다.',
    keywords: [
      'id',
      'identity',
      'geometryGroup',
      'surfaceGroup',
      'semantic surface',
      'surface-N',
      'operation',
      'Fragment',
    ],
    content: [
      '`id`는 단순한 화면 label이 아니라 Geometry 결과의 identity입니다. custom `Geometry` component를 호출할 때는 `id`가 필수이고, 모든 intrinsic primitive와 operation에는 필요할 때 `id`를 줄 수 있습니다. Fragment(`<>...</>`)에는 `id`나 transform을 줄 수 없습니다.',
      '',
      '- primitive의 `id`는 그 primitive가 만든 part를 소유합니다.',
      '- topology를 바꾸는 `union`, `subtract`, `intersect`, `shell` 같은 operation에 `id`가 있으면 그 operation의 최종 결과가 해당 identity를 소유합니다. 피연산자 ID가 Boolean 결과의 ID라고 가정하지 마세요.',
      '- component의 `id`는 재사용되는 subtree의 namespace/root identity가 됩니다. 같은 parent 아래의 sibling ID는 서로 달라야 합니다.',
      '- evaluator가 component 호출의 `id`를 이미 소비하므로 받은 `id`를 leaf intrinsic에 그대로 전달하지 마세요. child에 별도 local segment가 필요할 때만 intrinsic `id`를 부여합니다.',
      '- `geometryGroup`에는 의도적으로 부여한 결과 ID만 넣고, 실행 전에 Viewer에서 실제 resolve 결과를 확인하세요.',
      '- CAD API v10 surface는 `<geometry-id>/surface/<URL-encoded-face-key>`로 참조합니다. 예를 들어 `conductor.body` leaf의 `+X` face는 `conductor.body/surface/%2BX`입니다. leaf에 명시적 `id`를 주고 Geometry Catalog와 Viewer에 표시된 face key를 사용하세요.',
      '- CAD API v7-v9 bundle은 계속 열어 읽을 수 있지만 `/surface-N`을 포함하면 Prepared Measurement를 만들거나 Solver를 실행할 수 없습니다. ordinal을 semantic face로 자동 alias하지 않으므로 원본 Version은 보존하고 CAD API v10의 새 Version에서 명시적으로 이행하세요.',
      '- 한 Boolean operation은 최대 128개 operand를 받습니다. 큰 lattice를 중첩 Boolean으로 전개하면 Manifold 실행 전에 triangle 및 triangle-pair work 예산에서 거부됩니다.',
      '',
      '중간 조립용 Fragment에 억지로 identity를 만들기보다 named `Geometry` component로 추출하세요. 반대로 solver가 최종 Boolean body 하나만 필요하면 operation에 `id`를 주는 편이 소유권이 가장 분명합니다.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-geometry-elements',
    section: 'reference',
    anchor: 'cad-reference-geometry-elements',
    title: 'Primitive 선택과 operation 규칙',
    summary: '가장 단순한 primitive에서 시작하고 child cardinality와 순서 계약을 지킵니다.',
    keywords: ['box', 'cylinder', 'sphere', 'fiber', 'array', 'shell', 'union', 'subtract', 'intersect', 'children'],
    content: [
      '표현할 수 있다면 `Box`, `Cylinder`, `Sphere`부터 사용하세요. Primitive는 `@caemble/core`에서 PascalCase로 import하고 operation은 lowercase JSX tag로 작성합니다. 곡선 단면·표면이 실제 요구사항일 때만 `CurvedEdgeCylinder`, `CurvedSurfaceSphere`, `Fiber`를 선택하면 parameter와 mesh 비용을 줄일 수 있습니다. 각 prop의 type, 필수 여부, 기본값, 제약, 기준 원점, surface 의미와 실행 가능한 예제는 [Geometry Catalog](/docs?section=geometry)가 공식 원본입니다.',
      '',
      '| Operation | child 계약 | 핵심 규칙 |',
      '| --- | --- | --- |',
      '| `translate` | 1개 이상 | `offset` Vec3로 child group을 상대 이동 |',
      '| `rotate` | 1개 이상 | `axis`와 radian `angle`로 오른손 axis-angle 회전 |',
      '| `scale` | 1개 이상 | `x`, `y`, `z` 축별 배율을 local 원점 기준으로 적용 |',
      '| `union` | 1개 이상 | 모든 child를 하나의 결과로 결합 |',
      '| `subtract` | 2개 이상 | 첫 child가 base, 이후 child는 cutter |',
      '| `intersect` | 2개 이상 | 모든 child의 공통 체적만 유지 |',
      '| `shell` | 정확히 1개 | material role별 offset surface 생성 |',
      '| `array` | 정확히 1개의 identified intrinsic 또는 `Geometry` child | `shape`, `period`, 선택적 `axes`와 canonical `inject`로 instance 생성 |',
      '',
      'Boolean child 순서는 source 계약의 일부입니다. ring은 큰 cylinder 하나로 근사하지 말고, 큰 cylinder에서 더 높고 작은 cylinder를 빼서 실제 annular solid를 만드세요. 0 두께, 음수 크기, NaN/Infinity, 퇴화한 축처럼 유효하지 않은 입력은 evaluator가 거부합니다.',
      '',
      'Material은 root에서 역할 map으로 주입하고 leaf에서 `body`로 remap합니다. 생략하면 parent map을 상속하고, 명시하면 교체하며, `materials={{}}`는 상속을 지웁니다. 자세한 선언과 sampling 계약은 [Material과 물성값](/docs?section=program#experiment-materials)을 참고하세요.',
    ].join('\n'),
  }),
  manualChunk({
    id: 'reference-basketball-goal',
    section: 'reference',
    anchor: 'cad-reference-basketball-goal',
    title: '검증 예제: Basketball Goal',
    summary: '지지대, 수평 암, 백보드와 실제 annular rim을 canonical v8 문법으로 조립합니다.',
    keywords: ['basketball', 'goal', 'hoop', 'pole', 'backboard', 'ring', 'verified example', '농구', '골대'],
    collapsed: true,
    content: [
      '이 예제는 SQLite 카탈로그의 source를 직접 compile/evaluate하는 회귀 테스트 대상입니다.',
      '',
      '[Basketball Goal canonical Experiment bundle 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/getting-started/basketball-goal@1.0.0)',
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
      '| `Box` 등 | Geometry TSX | PascalCase primitive literal alias |',
      '| `radians` | Geometry transform | degree number 또는 Vec3를 radian으로 변환 |',
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
      '4. `varsSchema`의 필수 shape, scalar min/max, Candidate의 정확한 shape, Geometry ID 중복과 group member ID를 확인합니다.',
      '5. surface group이 semantic `<geometry-id>/surface/<URL-encoded-face-key>`를 사용하고 `/surface-N` ordinal이 남지 않았는지 확인합니다.',
      '6. Material key, dtype, unit과 tensor shape를 catalog와 비교합니다.',
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
      title: entry.authoringName,
      summary: entry.summary,
      item: entry.tag,
      href: docsSectionHref('geometry', entry.tag),
      keywords: Object.freeze([
        entry.authoringName,
        entry.tag,
        entry.category,
        entry.syntax,
        ...entry.keywords,
        ...entry.properties.flatMap(({ name, type }) => [name, type]),
      ]),
      content: [
        `Authoring name: ${entry.authoringName}`,
        `Registry tag: ${entry.tag}`,
        `Category: ${entry.category}`,
        `Syntax: ${entry.syntax}`,
        `Summary: ${entry.summary}`,
        `Origin: ${entry.origin}`,
        `Children (${entry.children.count}): ${entry.children.description}`,
        '',
        'Properties:',
        ...entry.properties.map(
          (property) =>
            `- ${property.name}: ${property.type}; ${property.required ? 'required' : 'optional'}${'default' in property && property.default !== undefined ? `; default ${property.default}` : ''}. ${property.description}`,
        ),
        '',
        'Surfaces:',
        ...(entry.surfaces.length ? entry.surfaces.map((surface) => `- ${surface}`) : ['- No fixed surface contract.']),
        '',
        '검증된 부분 TSX 예시 — 완성 파일이 아닌 단일 element 식:',
        '```tsx',
        entry.example,
        '```',
      ].join('\n'),
    }),
  ),
])

export function catalogSearchKnowledge(items: readonly CatalogSearchItem[]): readonly DocsKnowledgeChunk[] {
  return Object.freeze(
    items.map((item) => {
      const section =
        item.kind === 'quantityKind'
          ? 'quantity-kinds'
          : item.kind === 'solver' || item.kind === 'experiment'
            ? 'solvers'
            : 'materials'
      const selectedItem = item.kind === 'experiment' ? `experiment:${item.key}` : item.key
      return Object.freeze({
        id: `${item.kind}:${item.key}`,
        section,
        title: item.title,
        summary: item.subtitle,
        item: selectedItem,
        href: docsSectionHref(section, selectedItem),
        keywords: Object.freeze([item.kind, item.key, item.title, item.subtitle]),
        content: item.subtitle,
      })
    }),
  )
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
