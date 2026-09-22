import { ArrowRight, BookOpenText, Check, Code2, Compass, Layers3, Play, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { helpHref } from '@/documentation/helpNavigation'
import { documentationCatalogs } from '@/documentation/navigation'

const firstSteps = [
  { title: '예제 열기', detail: '완성된 실험으로 시작합니다.', icon: BookOpenText },
  { title: '조건 확인', detail: '변수와 형상을 살펴봅니다.', icon: SlidersHorizontal },
  { title: '한 번 실행', detail: '원하는 조건으로 계산합니다.', icon: Play },
  { title: '결과 확인', detail: '기록된 결과를 읽어 봅니다.', icon: Check },
]
const tasks = [
  {
    id: 'workbench-measurement',
    title: '조건을 바꾸며 실험하기',
    detail: '변수를 조절하고 실행 결과를 비교합니다.',
    icon: SlidersHorizontal,
  },
  {
    id: 'workbench-calculation',
    title: '결과에서 필요한 값 구하기',
    detail: '기록된 데이터로 계산하고 차트를 만듭니다.',
    icon: Layers3,
  },
  {
    id: 'workbench-prediction',
    title: '다음 실험 조건 탐색하기',
    detail: '쌓인 결과로 예측하고 새로운 조건을 찾습니다.',
    icon: Compass,
  },
  {
    id: 'program-overview',
    title: '코드로 내 실험 만들기',
    detail: '파일의 역할부터 차근차근 알아봅니다.',
    icon: Code2,
  },
]

export function HelpHome() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-10 sm:py-12">
      <section className="grid gap-8 border-b pb-10 xl:grid-cols-[minmax(0,1.25fr)_minmax(17rem,1fr)] xl:gap-12">
        <div className="self-center">
          <p className="mb-4 flex items-center gap-2 text-sm font-medium text-primary">
            <span className="h-px w-6 bg-primary/60" /> CAEMBLE GUIDE
          </p>
          <h1 className="max-w-xl text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            첫 실험부터,
            <br />
            차근차근 함께합니다
          </h1>
          <p className="mt-5 max-w-lg text-base leading-8 text-muted-foreground">
            예제를 열어 보고, 조건을 바꾸고, 결과를 확인해 보세요. Caemble이 처음이어도 필요한 순서대로 안내합니다.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button asChild className="h-11 rounded-lg px-5">
              <a href={helpHref('manual', 'workbench-quickstart')}>
                첫 실험 따라 하기 <ArrowRight className="size-4" />
              </a>
            </Button>
            <a
              className="rounded-md px-2 py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              href={helpHref('manual', 'workbench-showcase')}
            >
              먼저 둘러보고 싶어요 <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="mt-4 text-xs leading-6 text-muted-foreground">
            문서와 공개 예제는 로그인 없이 살펴볼 수 있습니다.
          </p>
        </div>
        <div className="rounded-2xl border border-primary/10 bg-accent/40 p-6 sm:p-7">
          <h2 className="mb-5 text-sm font-semibold">첫 실험은 이렇게 진행합니다</h2>
          <ol className="space-y-5">
            {firstSteps.map(({ title, detail, icon: Icon }, index) => (
              <li key={title} className="flex items-center gap-4">
                <span className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-background text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                  {index < firstSteps.length - 1 ? <span className="absolute top-full h-5 w-px bg-primary/15" /> : null}
                </span>
                <div>
                  <p className="text-sm font-semibold">
                    <span className="mr-2 text-xs font-normal text-primary">0{index + 1}</span>
                    {title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="py-9">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight">지금 하고 싶은 일은 무엇인가요?</h2>
          <a href={helpHref('manual', 'workbench-authoring-cycle')} className="text-sm text-primary hover:underline">
            기본 개념 알아보기 →
          </a>
        </div>
        <div className="grid gap-x-8 sm:grid-cols-2">
          {tasks.map(({ id, title, detail, icon: Icon }) => (
            <a
              key={id}
              href={helpHref('manual', id)}
              className="group flex items-start gap-4 rounded-xl px-3 py-5 transition-colors hover:bg-muted/60"
            >
              <Icon className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{detail}</p>
              </div>
              <ArrowRight
                className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1"
                aria-hidden="true"
              />
            </a>
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-muted/25 px-5 py-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div>
          <h2 className="font-semibold">진행하다 막혔나요?</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            오류 메시지나 지금 보이는 상태에서 해결 방법을 찾아보세요.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-sm font-medium sm:mt-0 sm:shrink-0">
          <a className="text-primary hover:underline" href={helpHref('manual', 'troubleshooting-ready')}>
            Ready가 안 될 때 →
          </a>
          <a className="text-primary hover:underline" href={helpHref('manual', 'troubleshooting-runtime-results')}>
            실행·결과 문제 →
          </a>
        </div>
      </section>

      <section className="pt-10 pb-3">
        <h2 className="text-xl font-semibold tracking-tight">필요할 때 찾아보는 참고 자료</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          사용할 수 있는 형상, 재료와 해석 도구의 정확한 규격을 확인합니다.
        </p>
        <div className="mt-5 grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
          {documentationCatalogs.map(({ kind, label, description }) => (
            <a key={kind} href={helpHref(kind)} className="rounded-lg py-3 hover:text-primary">
              <p className="text-sm font-medium">
                {label}{' '}
                <span aria-hidden="true" className="ml-1 text-muted-foreground">
                  ↗
                </span>
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            </a>
          ))}
          <a href={helpHref('manual', 'reference-core-api')} className="rounded-lg py-3 hover:text-primary">
            <p className="text-sm font-medium">
              핵심 API{' '}
              <span aria-hidden="true" className="ml-1 text-muted-foreground">
                ↗
              </span>
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">코드 작성에 쓰는 주요 기능</p>
          </a>
        </div>
      </section>
    </div>
  )
}
