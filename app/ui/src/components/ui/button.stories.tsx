import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArrowRight } from 'lucide-react'
import { Button } from './button'

const meta = {
  title: 'UI/Button',
  component: Button,
  args: { children: 'Viewer 시작하기' },
  tags: ['autodocs'],
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}
export const Secondary: Story = { args: { variant: 'outline' } }
export const Disabled: Story = { args: { disabled: true } }
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <span>카탈로그 보기</span>
        <ArrowRight />
      </>
    ),
  },
}
