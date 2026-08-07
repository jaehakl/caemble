cd ./app/launcher

# 백그라운드 실행
nohup poetry run launcher > launcher.log 2>&1 &
echo $! > launcher.pid