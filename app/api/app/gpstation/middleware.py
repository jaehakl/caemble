from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send


V1_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": (
        "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT"
    ),
    "Access-Control-Max-Age": "600",
}


class V1PublicCorsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith(
            "/v1/"
        ):
            await self.app(scope, receive, send)
            return

        request_headers = Headers(scope=scope)
        if not request_headers.get("origin"):
            await self.app(scope, receive, send)
            return

        allow_headers = (
            request_headers.get("access-control-request-headers")
            or "authorization, content-type"
        )
        cors_headers = {
            **V1_CORS_HEADERS,
            "Access-Control-Allow-Headers": allow_headers,
        }
        if (
            scope.get("method") == "OPTIONS"
            and request_headers.get("access-control-request-method")
        ):
            await Response(status_code=200, headers=cors_headers)(
                scope,
                receive,
                send,
            )
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "Access-Control-Allow-Credentials" in headers:
                    del headers["Access-Control-Allow-Credentials"]
                for name, value in cors_headers.items():
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_cors)
