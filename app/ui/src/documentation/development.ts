import page0 from '../../../../docs/development/architecture.md?raw'
import page1 from '../../../../docs/development/solver-development.md?raw'
import page2 from '../../../../docs/development/ui.md?raw'
import page3 from '../../../../docs/development/api.md?raw'
import page4 from '../../../../docs/development/cae.md?raw'
import page5 from '../../../../docs/development/cad-elements.md?raw'
import page6 from '../../../../docs/development/documentation.md?raw'
import page7 from '../../../../docs/operations/deployment.md?raw'
import page8 from '../../../../docs/operations/workers.md?raw'
import storagePage from '../../../../docs/operations/object-storage.md?raw'
import page9 from '../../../../docs/README.md?raw'
import type { DocumentPage } from './types'
import { documentBody } from './body'

/** Repository-only documentation; never import into web entry points. */
export const developmentDocuments: readonly DocumentPage[] = [
  {
    ...{
      id: 'development.architecture',
      title: 'Caemble architecture',
      summary: 'Caemble architecture',
      sourcePath: 'docs/development/architecture.md',
      keywords: ['architecture', 'runtime', 'artifact'],
    },
    content: documentBody(page0),
  },
  {
    ...{
      id: 'development.solver',
      title: 'CAE Solver 개발 가이드',
      summary: 'CAE Solver 개발 가이드',
      sourcePath: 'docs/development/solver-development.md',
      keywords: ['solver', 'ABI', 'Catalog', 'pytest'],
    },
    content: documentBody(page1),
  },
  {
    ...{
      id: 'development.ui',
      title: 'Caemble UI',
      summary: 'Caemble UI',
      sourcePath: 'docs/development/ui.md',
      keywords: ['UI', 'CLI', 'build', 'frontend'],
    },
    content: documentBody(page2),
  },
  {
    ...{
      id: 'development.api',
      title: 'Caemble API',
      summary: 'Caemble API',
      sourcePath: 'docs/development/api.md',
      keywords: ['API', 'database', 'migration'],
    },
    content: documentBody(page3),
  },
  {
    ...{
      id: 'development.cae',
      title: 'Caemble CAE worker',
      summary: 'Caemble CAE worker',
      sourcePath: 'docs/development/cae.md',
      keywords: ['CAE', 'kernel', 'resources'],
    },
    content: documentBody(page4),
  },
  {
    ...{
      id: 'development.cad-elements',
      title: 'CAD element 추가하기',
      summary: 'CAD element 추가하기',
      sourcePath: 'docs/development/cad-elements.md',
      keywords: ['CAD', 'element', 'props'],
    },
    content: documentBody(page5),
  },
  {
    ...{
      id: 'development.documentation',
      title: 'Documentation maintenance',
      summary: 'Documentation maintenance',
      sourcePath: 'docs/development/documentation.md',
      keywords: ['docs', 'documentation', 'Markdown'],
    },
    content: documentBody(page6),
  },
  {
    ...{
      id: 'operations.deployment',
      title: 'Caemble deployment',
      summary: 'Caemble deployment',
      sourcePath: 'docs/operations/deployment.md',
      keywords: ['deployment', 'Nginx', 'release'],
    },
    content: documentBody(page7),
  },
  {
    ...{
      id: 'operations.workers',
      title: 'Caemble worker applications',
      summary: 'Caemble worker applications',
      sourcePath: 'docs/operations/workers.md',
      keywords: ['workers', 'Launcher', 'AI'],
    },
    content: documentBody(page8),
  },
  {
    ...{
      id: 'operations.object-storage',
      title: '대용량 데이터의 S3 직접 전송',
      summary: 'AWS 설정, 브라우저 CORS, 배포와 객체 보관',
      sourcePath: 'docs/operations/object-storage.md',
      keywords: ['S3', 'AWS', 'storage', 'CORS'],
    },
    content: documentBody(storagePage),
  },
  {
    ...{
      id: 'documentation.map',
      title: 'Caemble documentation',
      summary: 'Caemble documentation',
      sourcePath: 'docs/README.md',
      keywords: ['documentation', 'AGENTS.md', 'Codex'],
    },
    content: documentBody(page9),
  },
]
