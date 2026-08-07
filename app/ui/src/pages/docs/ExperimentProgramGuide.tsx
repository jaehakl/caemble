import { ArrowRight, Boxes, Braces, CircleDot, GitBranch, PlayCircle } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { caembleProgramExamples } from '@/lib/examples'

const ownership = [
  ['varsSchema', 'Structure/Experiment 최상위', 'run 전에 결정되는 immutable 설계·실험 변수'],
  ['geometry, groups, lengthUnit', 'Structure/Experiment 최상위', 'reference geometry, stable target, 저작 단위'],
  ['tasks()', 'Experiment 최상위', 'vars로 각 kernel task를 구성하는 factory'],
  ['task.outputs', 'kernel task 내부', '다른 kernel에도 전달할 중간 artifact 요청'],
  ['recordedData', 'Experiment 최상위', 'Measurement에 최종 저장할 데이터 schema'],
  ['simulate.py', 'Experiment Python tab', 'task 순서, 분기, artifact 전달·해제·기록 정책'],
] as const

const dcMethods = [
  ['dc.voxel-grid', 'initializations', 'structure.geometry.<group>', 'gridShape'],
  ['dc.source-potential', 'boundaryConditions', 'structure.surface.<group>', 'voltage'],
  ['dc.reference-potential', 'boundaryConditions', 'structure.surface.<group>', 'voltage'],
  ['dc.current-density', 'outputs', 'structure.geometry.<group>', 'crossSectionPosition'],
  ['dc.total-current', 'outputs', 'structure.geometry.<group>', 'crossSectionPosition'],
  ['dc.joule-heating', 'outputs', 'structure.geometry.<group>', '—'],
  ['heat.voxel-grid', 'initializations', 'structure.geometry.<group>', 'gridShape'],
  ['heat.fixed-temperature', 'boundaryConditions', 'structure.surface.<group>', 'temperature'],
  ['heat.temperature', 'outputs', 'structure.geometry.<group>', '—'],
  ['heat.maximum-temperature', 'outputs', 'structure.geometry.<group>', '—'],
] as const

function Code({ children }: { children: string }) {
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.82em] text-slate-800">{children}</code>
}

export function ExperimentProgramGuide() {
  const firstExample = caembleProgramExamples[0]

  return (
    <section className="bg-white">
      <div className="mx-auto max-w-6xl space-y-10 px-4 py-7 sm:px-6 sm:py-10">
        <header className="overflow-hidden rounded-2xl border bg-gradient-to-br from-orange-50 via-white to-slate-50 p-6 sm:p-9">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Experiment Program</Badge>
            <Badge className="border bg-white">@caemble/core</Badge>
          </div>
          <h2 className="mt-5 max-w-3xl text-2xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            kernel task를 조합해 문제에 맞는 CAE 프로그램을 작성합니다
          </h2>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
            고정된 geometry와 설계 변수는 Experiment 최상위에 두고, 물리 분야별 수치 설정은 named task로 분리합니다.{' '}
            Python <Code>simulate()</Code>에는 task의 선택·순서·분기와 결과 기록만 남깁니다.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link to={`/examples/${firstExample.id}`}>
                <PlayCircle />첫 예제 실행
              </Link>
            </Button>
            <Button asChild variant="outline">
              <a href="#experiment-program-minimal-pair">
                최소 코드 보기
                <ArrowRight />
              </a>
            </Button>
          </div>
        </header>

        <section aria-labelledby="experiment-program-mental-model">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-orange-100 text-orange-800">
              <GitBranch className="size-4" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-950" id="experiment-program-mental-model">
                먼저 책임을 세 계층으로 나눕니다
              </h3>
              <p className="text-sm text-slate-600">definition, kernel task, orchestration의 경계를 유지하세요.</p>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="border-b px-4 py-3 font-semibold">항목</th>
                  <th className="border-b px-4 py-3 font-semibold">정의 위치</th>
                  <th className="border-b px-4 py-3 font-semibold">역할</th>
                </tr>
              </thead>
              <tbody>
                {ownership.map(([name, location, meaning]) => (
                  <tr className="border-b last:border-0" key={name}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-900">{name}</td>
                    <td className="px-4 py-3 text-slate-700">{location}</td>
                    <td className="px-4 py-3 text-slate-600">{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            run 중 계산된 물리량은 <Code>varsSchema</Code>를 다시 평가해 표현하지 않습니다. kernel의 opaque state와
            artifact handle을 Python <Code>simulate()</Code>에서 다음 task에 명시적으로 전달합니다.
          </p>
        </section>

        <section className="grid gap-4 lg:grid-cols-3" aria-label="Experiment Program 작성 순서">
          <Card>
            <CardHeader>
              <Boxes className="size-5 text-orange-700" />
              <CardTitle className="text-base">1. 고정 세계 정의</CardTitle>
              <CardDescription>
                Structure와 Experiment geometry, stable ID, group, lengthUnit을 작성합니다.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CircleDot className="size-5 text-orange-700" />
              <CardTitle className="text-base">2. named task 선언</CardTitle>
              <CardDescription>
                <Code>{'tasks: ({ vars }) => ({ ... })'}</Code>에서 kernel 전용 설정과 중간 output을 정의합니다.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Braces className="size-5 text-orange-700" />
              <CardTitle className="text-base">3. 실행 정책 작성</CardTitle>
              <CardDescription>
                Python <Code>sim.run()</Code>으로 artifact를 교환하고 <Code>await sim.record()</Code>로 RecordedData를
                확정합니다.
              </CardDescription>
            </CardHeader>
          </Card>
        </section>

        <section className="space-y-4" id="experiment-program-minimal-pair">
          <div>
            <h3 className="font-semibold text-slate-950">동작 검증된 최소 Structure–Experiment pair</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              아래 코드는 Playground와 자동 통합 테스트가 그대로 import하는 fixture입니다. 별도의 문서용 복사본이
              아닙니다.
            </p>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <details className="overflow-hidden rounded-xl border bg-slate-950 text-slate-100" open>
              <summary className="cursor-pointer border-b border-slate-800 px-4 py-3 text-sm font-semibold">
                Structure Source
              </summary>
              <pre className="max-h-[520px] overflow-auto p-4 text-xs leading-5">
                <code>{firstExample.structureCode}</code>
              </pre>
            </details>
            <details className="overflow-hidden rounded-xl border bg-slate-950 text-slate-100 xl:col-span-2" open>
              <summary className="cursor-pointer border-b border-slate-800 px-4 py-3 text-sm font-semibold">
                Python simulate.py
              </summary>
              <pre className="max-h-[520px] overflow-auto p-4 text-xs leading-5">
                <code>{firstExample.simulationCode}</code>
              </pre>
            </details>
            <details className="overflow-hidden rounded-xl border bg-slate-950 text-slate-100" open>
              <summary className="cursor-pointer border-b border-slate-800 px-4 py-3 text-sm font-semibold">
                Experiment Source
              </summary>
              <pre className="max-h-[520px] overflow-auto p-4 text-xs leading-5">
                <code>{firstExample.experimentCode}</code>
              </pre>
            </details>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">@caemble/core 실행 규칙</CardTitle>
              <CardDescription>state와 artifact는 현재 run 안에서만 유효한 capability reference입니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-slate-600">
              <p>
                <Code>{'tasks({ vars })'}</Code>는 CAE slave에서 Python <Code>simulate()</Code>를 시작하기 전에 한 번
                평가됩니다.
              </p>
              <p>
                kernel이 자기 opaque state를 변경했을 때만 revision이 증가합니다. 실패한 호출은 state와 artifact를 함께
                rollback하므로 같은 입력 state에서 다른 branch를 실행할 수 있습니다.
              </p>
              <p>
                다른 run의 ref, release한 ref, 잘못된 artifact·observation schema, 취소·격리 위반은 fatal 오류이며
                사용자 코드가 catch해도 run 전체가 실패합니다.
              </p>
              <p>
                <Code>await sim.record()</Code>는 global RecordedData schema로 정규화하고 browser ACK를 기다립니다. 뒤
                task가 실패하면 provisional 결과 전체를 폐기합니다.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">DC·Heat kernel의 현재 한계</CardTitle>
              <CardDescription>CAE slave가 실행하는 bounded reference kernel입니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-slate-600">
              <p>하나의 연결된 homogeneous isotropic conductor와 서로 마주 보는 두 planar terminal을 지원합니다.</p>
              <p>
                Material에는 양의 <Code>electrical.conductivity = σI</Code>가 필요하며 global identity basis만
                지원합니다. Heat task에는 양의 <Code>thermal.conductivity = kI</Code>가 추가로 필요합니다.
              </p>
              <p>
                voxel grid의 각 축은 3 이상이고 총 cell 수는 250,000 이하여야 합니다. Heat는 두 끝면의 고정온도와 나머지
                단열면을 사용합니다. 길이, 전압, 온도, 전도도, 결과는 kernel 경계에서 SI로 변환됩니다.
              </p>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="font-semibold text-slate-950">defineTask · DC와 Heat method</h3>
          <div className="mt-4 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="border-b px-4 py-3 font-semibold">methodId</th>
                  <th className="border-b px-4 py-3 font-semibold">task field</th>
                  <th className="border-b px-4 py-3 font-semibold">target</th>
                  <th className="border-b px-4 py-3 font-semibold">parameter</th>
                </tr>
              </thead>
              <tbody>
                {dcMethods.map((row) => (
                  <tr className="border-b last:border-0" key={row[0]}>
                    {row.map((cell, index) => (
                      <td
                        className={index === 0 ? 'px-4 py-3 font-mono text-xs' : 'px-4 py-3 text-slate-600'}
                        key={cell}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="mb-4">
            <h3 className="font-semibold text-slate-950">단계별 실행 예제</h3>
            <p className="mt-1 text-sm text-slate-600">
              모든 예제는 실제 production kernel과 현재 공개 declaration으로 검증됩니다.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {caembleProgramExamples.map((example, index) => (
              <Card className="flex h-full flex-col" key={example.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <Badge className="border bg-white">0{index + 1}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {example.verification.kernelTasks.length} task
                    </span>
                  </div>
                  <CardTitle className="text-lg">{example.title}</CardTitle>
                  <CardDescription className="leading-5">{example.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <ul className="space-y-2 text-sm text-slate-600">
                    {example.concepts.map((concept) => (
                      <li className="flex gap-2" key={concept}>
                        <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-orange-500" />
                        {concept}
                      </li>
                    ))}
                  </ul>
                  <Button asChild className="mt-5 w-full" variant="outline">
                    <Link to={`/examples/${example.id}`}>
                      Playground에서 열기
                      <ArrowRight />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <h3 className="font-semibold">문제가 생기면 이 순서로 확인하세요</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Structure와 Experiment가 모두 Ready인지 확인합니다.</li>
            <li>Kernel descriptor에서 version과 target group 이름을 확인합니다.</li>
            <li>Material conductivity, grid cell 수, terminal surface와 voltage/temperature를 확인합니다.</li>
            <li>task output key, Experiment RecordedData 이름, sim.record 이름을 구분해 확인합니다.</li>
            <li>Source를 수정했다면 Stale 결과를 다시 실행합니다.</li>
          </ol>
          <p className="mt-3">
            저장소의 상세 문서는 <Code>docs/experiment-program.md</Code>에 있습니다.
          </p>
        </section>
      </div>
    </section>
  )
}
