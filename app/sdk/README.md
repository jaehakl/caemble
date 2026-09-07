# Caemble GPStation v1 SDK

이 package는 Caemble launcher와 slave가 공유하는 GPStation message/runtime을 제공한다.
Launcher manifest의 `job_mode`로 master와 연결하는 방식을 선택한다.

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

서버와 worker가 공유하는 `sdk.protocol.packets`는 작은 JSON header와 256 KiB 이하의
binary frame으로 payload와 attachment를 전달한다. `send_packet` 호출 전체를 하나의
send lock으로 보호하고 연결마다 `receive_packet`을 호출하는 reader는 하나만 둔다.
이 모듈과 서버 runtime은 WebRTC 의존성을 import하지 않는다.
