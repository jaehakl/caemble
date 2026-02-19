
- 다양한 오픈소스 CAE 소프트웨어들의 데이터베이스를 구축하여, 해결하려는 문제에 적합한 오픈소스 CAE SW 를 빠르게 찾아내고, 비교하고, 조사하고, 이해하고, 설치하고, 활용할 수 있도록 하는 서비스


- 서비스
	- sw_upsert_batch
	- sw_delete_batch
	- merge_topics
	- edit_topic
	- sw_search
	- sw_detail

- UI Pages
	- 필터 + 검색 & 리스트뷰
	- 상세 페이지 (softrares.full_name 을 기반으로 고유 url routing)
		- Review
		- 비슷한 SW 목록
	- 신규 등록(TSV 붙여넣기)
		- Topic 자동 추가
			- keyword 또는 keyword_alternatives 에 있는 것으로 따라감
			- 없으면 새로 생성
		- description 을 기반으로 embeddings 생성
	- 편집/삭제
	- Topic 통합
		- 여러 keyword 및 표제어 직접 입력
			- keyword_alternatives merge 하여 하나로 통합