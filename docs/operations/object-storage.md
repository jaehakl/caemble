# 대용량 데이터의 S3 직접 전송

BuiltMeasurement는 웹브라우저 또는 CLI에서 빌드한다. 64 KiB를 넘는 입력 본문과
RecordedData의 큰 tensor/field, CalculationData의 큰 array/image/map 값과 좌표는
S3에 저장한다. API는 객체 참조, 크기, SHA-256, dtype/shape 등의 메타데이터와
작업 상태를 저장한다. Calculation 실행과 후처리는 계속 Client에서 수행한다.
Calculation preflight layout의 큰 좌표 배열도 S3에 저장하며, layout 교체·Calculation 삭제 후 정리한다.

## 전송 경로

- 입력: Client에서 빌드 → Client가 S3에 업로드 → Batch commit → Slave가 S3에서 다운로드.
- RecordedData: Slave가 S3에 업로드 → API가 참조와 결과를 commit → Client가 S3에서 다운로드.
- CalculationData: Client에서 계산 → Client가 S3에 업로드 → API가 참조와 작은 분석 통계를 저장.

API는 권한을 확인하여 15분 유효한 GET/PUT URL을 발급한다. AWS 자격증명은 API에만 둔다.
객체는 8 MiB 조각으로 나누며, 각 조각의 SHA-256과 크기를 API가 S3 HEAD로 확인한다.
다운로더는 조각과 전체 SHA-256을 다시 검증한다. PUT에는 `If-None-Match: *`와
체크섬을 서명하여 같은 키의 내용을 덮어쓰지 못하게 한다. URL 만료와 일시적인 전송 실패는
URL을 다시 받아 최대 3회 시도한다. 큰 본문을 API로 우회 전송하는 fallback은 없다.

## 기존 AWS 설정

`app/api/.env`의 기존 `# AWS Bucket` 값을 그대로 사용한다.

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET`
- `S3_ENDPOINT_URL` (비어 있으면 해당 AWS Region의 S3 endpoint)

별도 버킷이나 Client/Slave용 AWS 키를 만들지 않는다. 객체 키는
`caemble/objects/<object-id>/<chunk-index>`이다. 이 prefix에 대한 `s3:PutObject`,
`s3:GetObject`, `s3:DeleteObject` 권한이 필요하다. SSE-KMS를 사용하는 버킷은
업로드와 체크섬 HEAD에 필요한 KMS 권한도 확인한다. 공개 버킷으로 전환할 필요는 없다.

## 브라우저 CORS와 CSP

S3 CORS는 Origin에서 버킷으로 보내는 요청을 허용해야 한다. 실제 운영/개발 앱 주소만 넣고
기존 버킷의 다른 CORS 규칙은 보존한다. S3 콘솔의 CORS 배열 예시는 다음과 같다.

```json
[
  {
    "AllowedOrigins": ["https://www.caemble.com", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-checksum-sha256", "if-none-match"],
    "ExposeHeaders": ["ETag", "x-amz-checksum-sha256"],
    "MaxAgeSeconds": 300
  }
]
```

설정 조회/수정은 `s3:GetBucketCORS`/`s3:PutBucketCORS` 권한이 있는 관리자가 수행한다.
CLI와 Slave에는 브라우저 CORS가 적용되지 않는다. 조건부 PUT 및 CORS 동작은
[AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)와
[AWS CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html)를 참고한다.

Nginx CSP도 S3 연결을 허용해야 한다. `deployment/update.sh`는 배포할
`app.conf`의 `__CAEMBLE_STORAGE_ORIGIN__`을 API `.env`에서 구한 S3 endpoint Origin으로
치환한다. API는 path-style 객체 주소를 사용하므로 해당 Origin과 서명 URL의 호스트가 일치한다.
수동 설치할 때도 API Poetry 환경에서 다음처럼 렌더링한 사본을 설치한다.

```bash
cp deployment/app.conf /tmp/caemble-app.conf
cd app/api
poetry run python ../../deployment/render-storage-csp.py /tmp/caemble-app.conf .env
```

메인 앱과 메인 Origin Worker에만 S3 접속을 허용한다. 격리된 CAD/Calculation runner의
네트워크 정책은 유지한다. 자격증명이나 서명 URL은 Nginx 설정·웹 artifact에 넣지 않는다.

## 배포와 보관

[일반 배포 절차](deployment.md)로 API·UI·CLI·Launcher·CAE를 같은 release로 갱신한다.
`poetry install --only main`과 `poetry run alembic upgrade head`가 필요하다.
Migration `000000000009`는 StorageObject 메타데이터와 Launcher 기능 필드를 추가하며
기존 inline/base64 결과 및 입력을 이동하거나 삭제하지 않는다. schema reset은 사용하지 않는다.
새 객체 입력 작업은 `storage_version: 1`을 알리는 새 Launcher/CAE에만 배정한다.
기존 작업·결과의 읽기와 기존 transport는 계속 지원한다.

결과 참조는 Measurement/CalculationData 저장과 같은 트랜잭션에서 연결한다.
Slave 결과는 현재 job/attempt에 한정하고 최종 commit 후 ACK한다. 실패한 이전 attempt의
업로드가 다음 attempt의 결과에 연결되지는 않는다. 기존 수동 retry 정책을 유지한다.

관련 Measurement/CalculationData가 존재하는 동안 객체를 보관한다. 미완료 업로드와
실패한 attempt는 마지막 메타데이터 갱신 후 24시간이 지난 정리 주기에 삭제한다.
이전에 저장된 데이터의 참조가 끊어지면 정리 대상임을 기록하고 추가로 24시간을 유예한다.
정리는 API의 별도 백그라운드 루프가 실행하며 API가 중지되어
있으면 다음 기동 후 처리한다. 삭제 실패는 재시도한다. 버킷 versioning이 켜져 있다면
이 삭제는 delete marker를 만들 수 있으므로 비현재 버전의 만료는 별도 S3 lifecycle로 관리한다.

## 검증 범위

로컬 테스트는 조각 전송/해시/재시도, 권한·attempt 경계, PostgreSQL migration과
batch/result 원자적 commit, 참조 삭제 후 정리를 검증한다. 실제 배포에서는 별도로
브라우저 PUT preflight, Client → S3 → Slave 입력, Slave → S3 → Client 결과,
CalculationData 저장·다시 열기, 다른 계정과 공개 Demo의 읽기 권한을 확인한다.
