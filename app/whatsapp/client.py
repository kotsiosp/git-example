"""WhatsApp Cloud API client: send text and documents, upload media.

Sending a document is a two-step flow: upload the file to /media to get a media id, then
send a document message referencing that id. This avoids needing a public URL for the PDF.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path

import httpx


class WhatsAppError(RuntimeError):
    pass


class WhatsAppClient:
    def __init__(
        self,
        token: str,
        phone_number_id: str,
        graph_version: str = "v21.0",
        http_client: httpx.Client | None = None,
        timeout: float = 30.0,
    ):
        if not token or not phone_number_id:
            raise ValueError("WhatsAppClient requires a token and phone_number_id")
        self.token = token
        self.phone_number_id = phone_number_id
        self.base_url = f"https://graph.facebook.com/{graph_version}"
        self._client = http_client or httpx.Client(timeout=timeout)
        self._owns_client = http_client is None

    @property
    def _auth(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def _post(self, path: str, **kwargs) -> dict:
        resp = self._client.post(f"{self.base_url}/{path}", headers=self._auth, **kwargs)
        if resp.status_code >= 400:
            raise WhatsAppError(f"WhatsApp API {resp.status_code}: {resp.text}")
        return resp.json()

    # -- messaging -----------------------------------------------------------
    def send_text(self, to: str, body: str) -> dict:
        """Send a plain text message. Long bodies are truncated to WhatsApp's limit."""
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"preview_url": False, "body": body[:4096]},
        }
        return self._post(f"{self.phone_number_id}/messages", json=payload)

    def upload_media(self, file_path: Path | str, mime_type: str | None = None) -> str:
        """Upload a file and return its media id."""
        file_path = Path(file_path)
        mime_type = mime_type or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        with open(file_path, "rb") as fh:
            files = {"file": (file_path.name, fh, mime_type)}
            data = {"messaging_product": "whatsapp", "type": mime_type}
            result = self._post(f"{self.phone_number_id}/media", data=data, files=files)
        media_id = result.get("id")
        if not media_id:
            raise WhatsAppError(f"Media upload returned no id: {result}")
        return media_id

    def send_document(
        self, to: str, file_path: Path | str, filename: str | None = None, caption: str | None = None
    ) -> dict:
        """Upload ``file_path`` and send it as a document message."""
        file_path = Path(file_path)
        media_id = self.upload_media(file_path)
        document: dict = {"id": media_id, "filename": filename or file_path.name}
        if caption:
            document["caption"] = caption[:1024]
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "document",
            "document": document,
        }
        return self._post(f"{self.phone_number_id}/messages", json=payload)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()
