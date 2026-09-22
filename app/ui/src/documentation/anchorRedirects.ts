/** Old shared links remain usable after sections are renamed or moved. */
export const documentationAnchorRedirects: Readonly<
  Record<string, Readonly<Record<string, { item: string; anchor: string }>>>
> = {
  'workbench-quickstart': {
    '시작-페이지와-showcase': { item: 'workbench-showcase', anchor: '시작-페이지와-showcase' },
    'experiment-레이아웃과-불러오기': { item: 'workbench-showcase', anchor: 'experiment-레이아웃과-불러오기' },
    '초기-화면과-대표이미지-수정': { item: 'workbench-save', anchor: '초기-화면과-대표이미지-수정' },
    'save와-save-as': { item: 'workbench-save', anchor: 'save와-save-as' },
    'measurement-탭': { item: 'workbench-measurement', anchor: 'measurement-탭' },
    'vars-편집': { item: 'workbench-measurement', anchor: 'vars-편집' },
    'pca와-후보-생성': { item: 'workbench-measurement', anchor: 'pca와-후보-생성' },
    'forward와-실제-결과-비교': { item: 'workbench-measurement', anchor: 'forward와-실제-결과-비교' },
  },
  'authoring-experiment': {
    'material-interactions': { item: 'authoring-experiment', anchor: '재료-사이의-상호작용-정의하기' },
  },
  'authoring-calculation': {
    'delete-calculations': { item: 'authoring-calculation', anchor: 'calculation-삭제하기' },
    'complex-recordeddata': { item: 'authoring-calculation', anchor: '복소수-recordeddata-다루기' },
  },
  'authoring-solver': {
    'particle-values-and-physical-arrays': { item: 'authoring-solver', anchor: '입자-값과-물리-배열-다루기' },
  },
}
