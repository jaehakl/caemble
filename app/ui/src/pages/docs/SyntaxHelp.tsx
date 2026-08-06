import { cadElementCatalog } from '@/lib/cad'

function Code({ children }: { children: string }) {
  return <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{children}</code>
}

function SyntaxHelp() {
  return (
    <section className="min-h-0 flex-1 overflow-auto bg-white">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-slate-950">Caemble Help</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
            Structure와 Experiment는 각각 하나의 TSX Source이며 <Code>{'structure({...})'}</Code>와{' '}
            <Code>{'experiment({...})'}</Code>를 default export합니다. Source revision은 한 번만 compile하고, vars
            변경과 Reroll은 같은 compiled source를 다시 evaluate합니다.
          </p>
        </div>

        <div className="space-y-5">
          {(['primitive', 'operation'] as const).map((category) => (
            <div key={category}>
              <h3 className="mb-3 text-sm font-semibold text-slate-800">
                {category === 'primitive' ? 'Primitives' : 'Geometry Operations'}
              </h3>
              <div className="overflow-hidden rounded border border-slate-200">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-2 font-semibold">Tag</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-semibold">Shape</th>
                      <th className="border-b border-slate-200 px-3 py-2 font-semibold">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cadElementCatalog
                      .filter((element) => element.category === category)
                      .map((element) => (
                        <tr className="border-b border-slate-100 last:border-b-0" key={element.tag}>
                          <td className="px-3 py-2 font-mono text-xs text-slate-900">{`<${element.tag}>`}</td>
                          <td className="px-3 py-2 font-mono text-xs text-slate-600">{element.syntax}</td>
                          <td className="px-3 py-2 text-slate-600">{element.summary}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
            <h3 className="font-semibold text-slate-900">Source와 import</h3>
            <p className="mt-2">
              공개 import는 <Code>@caemble/core</Code>와 <Code>@caemble/kernels</Code>만 허용합니다. 상대 경로, 동적
              import, <Code>require()</Code>, URL, 다른 package는 거부됩니다. 재사용할 Geometry component와 Material
              class는 같은 Source 안에 선언하세요.
            </p>

            <h3 className="mt-5 font-semibold text-slate-900">Vars와 Geometry</h3>
            <p className="mt-2">
              <Code>varsSchema</Code>의 min/max는 동일한 tensor shape를 사용합니다. Geometry callback은 명시적인{' '}
              <Code>{'({ vars })'}</Code> context를 받고, 모든 Geometry component 호출에는 같은 parent 아래에서 유일한{' '}
              <Code>id</Code>가 필요합니다. <Code>geometryGroup</Code>은 geometry ID를, <Code>surfaceGroup</Code>은{' '}
              <Code>partId/surface-N</Code>을 안정적인 kernel target으로 묶습니다.
            </p>

            <h3 className="mt-5 font-semibold text-slate-900">Material</h3>
            <p className="mt-2">
              Material property는 canonical key와 명시적인 dtype/unit을 사용합니다. 예를 들어 전도도는{' '}
              <Code>electrical.conductivity</Code>이고 isotropic 3×3 tensor는 <Code>Mat(value)</Code>로 작성합니다.
              optional <Code>errorRate</Code>는 property, Material, 기본값 순으로 적용되며 Reroll할 때 새 realization을
              만듭니다.
            </p>

            <h3 className="mt-5 font-semibold text-slate-900">Experiment task와 RecordedData</h3>
            <p className="mt-2">
              <Code>{'tasks: ({ vars }) => ({ electric: dcCurrentDensity({...}) })'}</Code>는 kernel별{' '}
              <Code>parameters</Code>, <Code>initializations</Code>, <Code>boundaryConditions</Code>,{' '}
              <Code>outputs</Code>를 정의합니다. task output은 중간 artifact 요청이며 Measurement schema가 아닙니다.
              Measurement에 저장할 최종 계약은 Experiment 최상위 <Code>recordedData</Code>에 한 번만 선언합니다.
            </p>
            <p className="mt-2">
              Python <Code>simulate()</Code>가 <Code>sim.run()</Code> 순서를 결정하고, <Code>inputs</Code>로 typed
              artifact를 다음 kernel에 전달합니다. <Code>await sim.record()</Code>는 artifact를 global RecordedData로
              승격하고 브라우저 ACK까지 실행을 정지합니다. <Code>sim.release()</Code>는 사용이 끝난 중간 artifact를
              해제합니다.
            </p>

            <h3 className="mt-5 font-semibold text-slate-900">DC current density와 steady-state Heat kernel</h3>
            <p className="mt-2">
              production catalog에는 <Code>dc-current-density@0.0.0</Code>과 <Code>steady-state-heat@0.0.0</Code>이
              있습니다. <Code>dc.voxel-grid</Code>, <Code>dc.source-potential</Code>,{' '}
              <Code>dc.reference-potential</Code>은 각각 정확히 한 번 필요하고, <Code>dc.current-density</Code>,{' '}
              <Code>dc.total-current</Code>, <Code>dc.joule-heating</Code> output을 요청할 수 있습니다. Heat는{' '}
              <Code>heat.voxel-grid</Code> 한 번과 서로 다른 <Code>heat.fixed-temperature</Code> 두 번이 필요합니다.
            </p>
            <p className="mt-2">
              하나의 연결된 homogeneous isotropic conductor, 서로 마주 보는 planar terminal, 최대 250,000 voxel을
              지원합니다. Heat의 선택적 <Code>heatSource</Code> port는 DC Joule heating artifact를 받아 3D temperature와
              maximum temperature를 계산합니다. 두 kernel 모두 <Code>iterations</Code>와 <Code>relativeResidual</Code>{' '}
              observation을 반환합니다.
            </p>

            <h3 className="mt-5 font-semibold text-slate-900">결과와 실행 상태</h3>
            <p className="mt-2">
              Run은 <Code>idle → preparing → running → succeeded | failed | cancelled</Code> 상태를 사용합니다. 중간
              artifact와 solver state는 CAE worker 밖으로 나오지 않습니다. 브라우저는 선언되고 실제{' '}
              <Code>sim.record()</Code>된 RecordedData만 받으며 trace와 provenance는 CAE 진단 로그에만 남습니다. 뒤
              kernel이 실패하면 provisional RecordedData와 Blob 전체를 폐기합니다.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

export default SyntaxHelp
