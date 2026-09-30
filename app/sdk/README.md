# Caemble GPStation v1 SDK

이 package는 Caemble launcher와 slave가 공유하는 GPStation message/runtime을 제공한다.
Launcher manifest의 `job_mode`로 master와 연결하는 방식을 선택한다.

실행 protocol 2는 launcher, boot, slave instance, Job, attempt와 reservation을 구분한다.
API·launcher·slave·master SDK를 함께 갱신한다. Launcher는 attempt마다 새 프로세스를
만들고 `sdk.slave.bootstrap`이 containment 준비 신호를 받은 뒤 앱을 import하게 한다.
`CAEMBLE_EXECUTION_JSON`의 identity와 allocation은 `context.execution`에서 읽는다.
CPU affinity·native thread 예산·GPU 노출은 import 전에 적용되며 물리 입력에 섞지 않는다.
GPU ordinal은 할당된 visible 장치 안의 순서이다. RAM 값은 시작 추정량과 실행 시점의
여유를 나타내며 hard memory limit이 아니다.

전체 identity는 `launcher_id`, `boot_id`, `instance_id`, `job_id`, `attempt_id`,
`attempt_count`, `reservation_id`이며 control/result JSON의 평면 필드로 전달한다.
연결 `session_id`는 재접속마다 바뀌고 실행 identity와 별도로 검증한다. 전송 context에
고정된 identity를 모든 진행률·호출·ACK·취소·완료 메시지에서 확인하며 이전 attempt의
메시지는 무시한다. Binary attachment 내용과 domain payload는 바꾸지 않는다.

- `webrtc` (기본값): 브라우저 등 외부 master와 연결한다. 기존 AI worker는
  `sdk.slave.SlaveApp`과 `run_app`을 그대로 사용한다.
- `websocket`: GPStation 서버가 master이며 worker에 직접 입력을 전달하고 결과를 저장한다.
  CAE worker는 `sdk.slave.server.ServerSlaveApp`과 `run_server_app`을 사용한다.

```powershell
cd app/sdk
python -m pip install -e ".[slave]"        # WebRTC worker
python -m pip install -e ".[server-slave]" # WebSocket worker
```

브라우저용 master SDK는 `master/js`, Python master SDK는 `master/python`에 있다. 두 SDK는
ordered RTCDataChannel을 열고 control frame과 attachment chunk를 전달하며 결과를 모두 받은
즉시 ACK를 보낸다. Attachment chunking과 buffered-amount backpressure는 전송 메커니즘이고,
domain schema나 크기 정책을 판정하지 않는다.

서버 방식의 handler는 `(input, attachments, context)`를 받고 완료 payload를 반환한다.
`context.send()`와 `context.receive()`로 메시지와 attachment를 교환하며, handler는
반환하거나 예외를 전달하기 전에 자식 프로세스와 계산 자원을 모두 정리해야 한다.
Runtime은 서버의 완료 ACK 이후 launcher에 `job.cleaned`를 전달한다. 연결 중단과 명시적
취소도 handler 정리가 끝난 후 처리하며 계산을 자동으로 재시도하지 않는다.
이 메시지는 handler 정리 알림이며, launcher는 해당 프로세스 트리의 종료를 확인한 뒤에만
예약을 반환한다. 진행률·ACK·취소·완료의 control frame은 전체 실행 identity로 검증한다.
이 프로세스 종료 경계 덕분에 AI 모델과 cache도 다음 Job으로 이어지지 않는다. 제어 연결의
기본 30초 재접속 유예와 달리 결과 WebSocket이 끊어진 계산은 복구하지 않으며, 정리 후
명시적으로 새 attempt를 요청한다. 자원 요청·기본값과 실제 RSS 기반 RAM 배정은
[worker 운영 안내](../../docs/operations/workers.md)를 참고한다.

서버와 worker가 공유하는 `sdk.protocol.packets`는 작은 JSON header와 256 KiB 이하의
binary frame으로 payload와 attachment를 전달한다. `send_packet` 호출 전체를 하나의
send lock으로 보호하고 연결마다 `receive_packet`을 호출하는 reader는 하나만 둔다.
이 모듈과 서버 runtime은 WebRTC 의존성을 import하지 않는다.
