# Caemble GPStation v1 SDK

이 package는 Caemble launcher와 slave가 공유하는 GPStation v1 message/runtime을 제공한다.
GPStation의 외부 protocol version은 유지하며 CAE domain payload는 별도 version wrapper 없이
전달한다.

```powershell
cd app/sdk
python -m pip install -e ".[slave]"
```

브라우저용 master SDK는 `master/js`, Python master SDK는 `master/python`에 있다. 두 SDK는
ordered RTCDataChannel을 열고 control frame과 attachment chunk를 전달하며 결과를 모두 받은
즉시 ACK를 보낸다. Attachment chunking과 buffered-amount backpressure는 전송 메커니즘이고,
domain schema나 크기 정책을 판정하지 않는다.
