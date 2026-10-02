export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null) return '관측 대기'
  const gib = bytes / 1024 ** 3
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`
}

export function describeResourceWait(reason: string | null | undefined): string | null {
  if (!reason) return null
  const labels: Record<string, string> = {
    cpu: 'CPU 반환 대기',
    cpu_exhausted: 'CPU 반환 대기',
    cpu_unavailable: 'CPU 반환 대기',
    insufficient_cpu: 'CPU 반환 대기',
    ram: 'RAM 여유 대기',
    ram_budget: 'RAM 예산 여유 대기',
    ram_pressure: 'RAM 여유 대기',
    insufficient_ram: 'RAM 여유 대기',
    system_memory: '장비 RAM 여유 대기',
    gpu: 'GPU 반환 대기',
    gpu_busy: 'GPU 반환 대기',
    gpu_unavailable: 'GPU 장치·메모리 여유 대기',
    gpu_metrics_unavailable: 'GPU 사용량 관측 대기',
    gpu_budget_unavailable: 'GPU 예약 예산 반환 대기',
    gpu_memory_pressure: 'GPU 물리 메모리 여유 대기',
    gpu_observing: 'GPU 시작 후 메모리 관측 중',
    insufficient_gpu: 'GPU 반환 대기',
    gpu_memory: 'GPU 메모리 여유 대기',
    metrics_unavailable: '자원 사용량 관측 대기',
    metrics_stale: '자원 사용량 갱신 대기',
    recovering: 'Launcher 연결 복구 중',
    cleanup_pending: '실행 프로세스 정리 중',
    request_exceeds_budget: '요청 자원이 Launcher 예산을 초과함',
    no_compatible_launcher: '호환 Launcher 연결 대기',
    resources_unavailable: '실행 가능한 Launcher의 자원 여유 대기',
  }
  return labels[reason] ?? `자원 배정 대기 (${reason})`
}
