import {
  Activity,
  Atom,
  BookOpenText,
  Boxes,
  ChartNoAxesCombined,
  Database,
  FlaskConical,
  GalleryVerticalEnd,
  Gauge,
  GitBranch,
  Home,
  Layers3,
  TestTubeDiagonal,
  type LucideIcon,
} from 'lucide-react'

export type AppNavigationItem = Readonly<{
  href: string
  icon: LucideIcon
  label: string
}>

export const primaryNavigation: readonly AppNavigationItem[] = [
  { href: '/', icon: Home, label: '홈' },
  { href: '/structures', icon: GitBranch, label: 'Structures' },
  { href: '/experiments', icon: TestTubeDiagonal, label: 'Experiments' },
  { href: '/examples', icon: GalleryVerticalEnd, label: 'Examples' },
  { href: '/measurements', icon: Activity, label: 'Measurements' },
  { href: '/analysis', icon: ChartNoAxesCombined, label: 'Analysis' },
  { href: '/materials', icon: Database, label: 'Materials' },
  { href: '/docs', icon: BookOpenText, label: 'Manual' },
]

export const catalogNavigation: readonly AppNavigationItem[] = [
  { href: '/catalog/cad', icon: Boxes, label: 'Geometry' },
  { href: '/catalog/materials', icon: Layers3, label: 'Material Catalog' },
  { href: '/catalog/quantity-kinds', icon: Gauge, label: 'Quantity' },
  { href: '/catalog/solvers', icon: FlaskConical, label: 'Physics' },
]

export const brandIcon = Atom
