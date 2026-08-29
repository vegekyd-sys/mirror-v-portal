#!/usr/bin/env python3
"""YCloud WhatsApp Business API client.

Authentication: X-API-Key header
Base URL: https://api.ycloud.com/v2
Docs: https://docs.ycloud.com/reference/introduction
"""

import os
import json
import sys
import argparse
import urllib.request
import urllib.error


DEFAULT_BASE_URL = "https://api.ycloud.com/v2"
ENV_KEY = "YCLOUD_API_KEY"

# ── 自动加载 .env（参考 dealclaw-find-buyers/_client.py，向上逐级找 work/mio-api/.env）──
_ENV_DIRS = []
_d = os.path.dirname(os.path.abspath(__file__))
while _d and _d != os.path.dirname(_d):
    _ENV_DIRS.append(os.path.join(_d, "work", "mio-api"))
    _ENV_DIRS.append(_d)
    _d = os.path.dirname(_d)
_ENV_DIRS.append(os.path.join(os.environ.get("HOME", ""), ".openclaw"))
for _d in _ENV_DIRS:
    _ENV_FILE = os.path.join(_d, ".env")
    if os.path.exists(_ENV_FILE):
        with open(_ENV_FILE) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    if _k not in os.environ:
                        os.environ[_k] = _v.strip()


def get_api_key():
    """Get API key from env or argument."""
    key = os.environ.get(ENV_KEY, "")
    if key:
        return key
    # fallback: check for key file
    keyfile = os.path.join(os.path.dirname(__file__), ".apikey")
    if os.path.exists(keyfile):
        with open(keyfile) as f:
            return f.read().strip()
    return ""


def api_request(method, path, data=None, api_key=None):
    """Make an authenticated request to YCloud API."""
    key = api_key or get_api_key()
    if not key:
        raise ValueError(f"No API key found. Set {ENV_KEY} env var or pass --key.")
    
    url = f"{DEFAULT_BASE_URL}{path}"
    headers = {
        "X-API-Key": key,
        "Content-Type": "application/json",
    }
    
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            return json.loads(err_body)
        except json.JSONDecodeError:
            return {"error": {"status": e.code, "message": err_body}}


def get_balance(api_key=None):
    """Get account balance."""
    return api_request("GET", "/balance", api_key=api_key)


def get_numbers(api_key=None):
    """List WhatsApp numbers."""
    return api_request("GET", "/whatsapp/numbers", api_key=api_key)


def get_templates(api_key=None, limit=20):
    """List WhatsApp message templates."""
    path = f"/whatsapp/templates?limit={limit}"
    return api_request("GET", path, api_key=api_key)


def create_template(name, language, category, components, api_key=None):
    """Create a WhatsApp message template.
    
    Args:
        name: Template name (lowercase, underscores)
        language: Language code, e.g. 'en', 'zh_CN'
        category: 'UTILITY', 'MARKETING', 'AUTHENTICATION'
        components: List of template components
    """
    data = {
        "name": name,
        "language": language,
        "category": category,
        "components": components,
    }
    return api_request("POST", "/whatsapp/templates", data=data, api_key=api_key)


def send_message_direct(from_number, to_number, msg_type, **kwargs):
    """Send a WhatsApp message directly.
    
    Args:
        from_number: Sender phone in E.164 format
        to_number: Recipient phone in E.164 format
        msg_type: 'text', 'template', 'image', 'video', 'audio', 'document', 
                  'sticker', 'location', 'interactive', 'contacts', 'reaction'
        **kwargs: type-specific payload fields
    """
    data = {
        "from": from_number,
        "to": to_number,
        "type": msg_type,
    }
    data.update(kwargs)
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data)


def send_text(from_number, to_number, text, preview_url=True, api_key=None):
    """Send a plain text WhatsApp message."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "text",
        "text": {
            "body": text,
            "preview_url": preview_url,
        },
    }
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_template(from_number, to_number, template_name, language_code,
                  components=None, api_key=None):
    """Send a template WhatsApp message."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {
                "code": language_code,
                "policy": "deterministic",
            },
        },
    }
    if components:
        data["template"]["components"] = components
    
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_image(from_number, to_number, link, caption=None, api_key=None):
    """Send an image via WhatsApp."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "image",
        "image": {"link": link},
    }
    if caption:
        data["image"]["caption"] = caption
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_video(from_number, to_number, link, caption=None, api_key=None):
    """Send a video via WhatsApp."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "video",
        "video": {"link": link},
    }
    if caption:
        data["video"]["caption"] = caption
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_document(from_number, to_number, link, filename=None, caption=None, api_key=None):
    """Send a document via WhatsApp."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "document",
        "document": {"link": link},
    }
    if filename:
        data["document"]["filename"] = filename
    if caption:
        data["document"]["caption"] = caption
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_audio(from_number, to_number, link, api_key=None):
    """Send audio via WhatsApp."""
    data = {
        "from": from_number,
        "to": to_number,
        "type": "audio",
        "audio": {"link": link},
    }
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_location(from_number, to_number, latitude, longitude, name=None, 
                  address=None, api_key=None):
    """Send a location via WhatsApp."""
    loc = {"latitude": latitude, "longitude": longitude}
    if name:
        loc["name"] = name
    if address:
        loc["address"] = address
    
    data = {
        "from": from_number,
        "to": to_number,
        "type": "location",
        "location": loc,
    }
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_contacts(from_number, to_number, contacts, api_key=None):
    """Send contacts via WhatsApp.
    
    Args:
        contacts: List of contact objects, each with at least 'name' and 
                  one or more phones list with 'phone' field.
    """
    data = {
        "from": from_number,
        "to": to_number,
        "type": "contacts",
        "contacts": contacts,
    }
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


def send_interactive(from_number, to_number, interactive_data, api_key=None):
    """Send an interactive WhatsApp message.
    
    Args:
        interactive_data: Full interactive message object per WhatsApp API spec
    """
    data = {
        "from": from_number,
        "to": to_number,
        "type": "interactive",
        "interactive": interactive_data,
    }
    return api_request("POST", "/whatsapp/messages/sendDirectly", data=data, api_key=api_key)


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="YCloud WhatsApp API client")
    parser.add_argument("--key", help="API key (or set YCLOUD_API_KEY env)")
    
    sub = parser.add_subparsers(dest="cmd")
    
    # balance
    sub.add_parser("balance", help="Check account balance")
    
    # numbers
    sub.add_parser("numbers", help="List WhatsApp numbers")
    
    # templates list
    sub.add_parser("templates", help="List templates")
    
    # send-text
    p_text = sub.add_parser("send-text", help="Send a text message")
    p_text.add_argument("--from", required=True, dest="from_", help="Sender E.164")
    p_text.add_argument("--to", required=True, help="Recipient E.164")
    p_text.add_argument("--text", required=True, help="Message body")
    p_text.add_argument("--no-preview", action="store_true", help="Disable link preview")
    
    # send-template
    p_tpl = sub.add_parser("send-template", help="Send a template message")
    p_tpl.add_argument("--from", required=True, dest="from_")
    p_tpl.add_argument("--to", required=True)
    p_tpl.add_argument("--name", required=True, help="Template name")
    p_tpl.add_argument("--lang", default="en", help="Language code")
    p_tpl.add_argument("--components", help="JSON file with components array")
    
    # send-image/video/doc
    for media_type in ["image", "video", "document", "audio"]:
        p = sub.add_parser(f"send-{media_type}", help=f"Send {media_type}")
        p.add_argument("--from", required=True, dest="from_")
        p.add_argument("--to", required=True)
        p.add_argument("--link", required=True, help="Media URL")
        p.add_argument("--caption", default=None)
        if media_type == "document":
            p.add_argument("--filename", default=None)
    
    args = parser.parse_args()
    api_key = args.key or get_api_key()
    
    if not api_key:
        print("Error: No API key. Set YCLOUD_API_KEY env or pass --key", file=sys.stderr)
        sys.exit(1)
    
    if args.cmd == "balance":
        result = get_balance(api_key=api_key)
    elif args.cmd == "numbers":
        result = get_numbers(api_key=api_key)
    elif args.cmd == "templates":
        result = get_templates(api_key=api_key)
    elif args.cmd == "send-text":
        result = send_text(args.from_, args.to, args.text, 
                          preview_url=not args.no_preview, api_key=api_key)
    elif args.cmd == "send-template":
        components = None
        if args.components:
            with open(args.components) as f:
                components = json.load(f)
        result = send_template(args.from_, args.to, args.name, args.lang,
                              components=components, api_key=api_key)
    elif args.cmd in ("send-image", "send-video", "send-document", "send-audio"):
        fn = {"send-image": send_image, "send-video": send_video,
              "send-document": send_document, "send-audio": send_audio}[args.cmd]
        kwargs = {"from_number": args.from_, "to_number": args.to, 
                  "link": args.link, "api_key": api_key}
        if hasattr(args, "caption") and args.caption:
            kwargs["caption"] = args.caption
        if hasattr(args, "filename") and args.filename:
            kwargs["filename"] = args.filename
        result = fn(**kwargs)
    else:
        parser.print_help()
        sys.exit(1)
    
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
