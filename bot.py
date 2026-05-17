from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from playwright.sync_api import Browser, BrowserContext, Locator, Page, Playwright, TimeoutError, sync_playwright


SITE_URL = "https://www.n12.co.il"
SHARED_CHAT_URL_TEMPLATE = (
    "https://mobile.mako.co.il/news-reporters_chat"
    "?messageId={message_id}&utm_source=SharedChatMessage"
    "&utm_medium=copy&partner=SharedChatMessage"
)
STATE_DIR = Path(".state")
STATE_FILE = STATE_DIR / "n12_anchor_chat.json"


@dataclass
class BotConfig:
    site_url: str = SITE_URL
    poll_seconds: float = 5.0
    headed: bool = False
    stale_refresh_cycles: int = 12
    feed_root_selector: str = ".mc-feed-content"
    message_selector: str = ".mc-message-wrap"
    message_share_selector: str = ".mc-message-share-button-wrapper"
    section_labels: list[str] = field(
        default_factory=lambda: [
            "צ'אט הכתבים",
            "כתבים",
            "reporters chat",
            "chat",
        ]
    )
    share_button_labels: list[str] = field(
        default_factory=lambda: [
            "share",
            "שתף",
            "שיתוף",
        ]
    )
    copy_button_labels: list[str] = field(
        default_factory=lambda: [
            "copy",
            "copy link",
            "העתק",
            "העתקת קישור",
            "העתק קישור",
        ]
    )
    item_selector_candidates: list[str] = field(
        default_factory=lambda: [
            "article",
            "[role='article']",
            "li",
            "[data-testid]",
            "a",
            "div",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch N12 anchor chat items and copy the newest shared entry.")
    parser.add_argument("--headed", action="store_true", help="Show the browser window.")
    parser.add_argument("--poll-seconds", type=float, default=5.0, help="Polling interval between checks.")
    parser.add_argument("--reset-state", action="store_true", help="Forget the last seen item before starting.")
    return parser.parse_args()


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_state(reset: bool) -> dict:
    if reset or not STATE_FILE.exists():
        return {}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state: dict) -> None:
    ensure_state_dir()
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def locator_text(locator: Locator) -> str:
    try:
        return normalize_text(locator.inner_text(timeout=2000))
    except TimeoutError:
        return ""
    except Exception:
        return ""


def attr(locator: Locator, name: str) -> str:
    try:
        return locator.get_attribute(name, timeout=1000) or ""
    except Exception:
        return ""


def build_shared_chat_url(message_id: str) -> str:
    return SHARED_CHAT_URL_TEMPLATE.format(message_id=message_id)


def message_id_value(locator: Locator) -> int:
    try:
        message_wrap = resolve_message_wrap(locator)
        raw_value = message_wrap.get_attribute("data-msg-id", timeout=500) if message_wrap else ""
    except Exception:
        raw_value = ""

    try:
        return int(raw_value) if raw_value else -1
    except ValueError:
        return -1


def resolve_message_wrap(locator: Locator) -> Locator | None:
    candidates = [
        locator,
        locator.locator("xpath=ancestor-or-self::div[contains(@class, 'mc-message-wrap')][1]").first,
        locator.locator(".mc-message-wrap").first,
    ]

    for candidate in candidates:
        try:
            if candidate.count():
                msg_id = candidate.get_attribute("data-msg-id", timeout=500) or ""
                if msg_id:
                    return candidate
        except Exception:
            continue

    return None


def first_visible(locator: Locator) -> Locator | None:
    try:
        count = locator.count()
    except Exception:
        return None

    for i in range(count):
        item = locator.nth(i)
        try:
            if item.is_visible(timeout=500):
                return item
        except Exception:
            continue
    return None


def find_section(page: Page, labels: Iterable[str]) -> Locator | None:
    for label in labels:
        try:
            generic = page.get_by_text(label, exact=False).first
            if generic.count():
                return generic.locator("xpath=ancestor-or-self::*[self::section or self::div][1]").first
        except Exception:
            continue

    return None


def find_feed_root(page: Page, cfg: BotConfig) -> Locator | None:
    locator = page.locator(cfg.feed_root_selector).first
    try:
        if locator.count() and locator.is_visible(timeout=1000):
            return locator
    except Exception:
        pass

    section = find_section(page, cfg.section_labels)
    if section is None:
        return None

    return section


def item_key(locator: Locator) -> str:
    try:
        message_wrap = resolve_message_wrap(locator)
        msg_id = message_wrap.get_attribute("data-msg-id", timeout=500) if message_wrap else ""
    except Exception:
        msg_id = ""

    if msg_id:
        return f"msg:{msg_id}"

    try:
        name = locator.locator(".mc-message-header__name").first.inner_text(timeout=500).strip()
    except Exception:
        name = ""

    try:
        body = locator.locator(".mc-extendable-text__content").first.inner_text(timeout=500).strip()
    except Exception:
        body = ""

    try:
        timestamp = locator.locator(".mc-message-footer__time").first.inner_text(timeout=500).strip()
    except Exception:
        timestamp = ""

    if name or body or timestamp:
        return normalize_text(f"{name}|{body}|{timestamp}")

    for field_name in ("href", "data-id", "data-testid", "id"):
        value = attr(locator, field_name)
        if value:
            return f"{field_name}:{value}"

    text = locator_text(locator)
    if text:
        return f"text:{text[:280]}"

    return "unknown"


def score_item(locator: Locator) -> tuple[int, int]:
    text = locator_text(locator)
    href = attr(locator, "href")
    return (1 if href else 0, len(text))


def newest_item(section: Locator, cfg: BotConfig) -> Locator | None:
    direct_messages = section.locator(cfg.message_selector)
    try:
        direct_count = direct_messages.count()
    except Exception:
        direct_count = 0

    if direct_count:
        best_item: Locator | None = None
        best_msg_id = -1

        indices = range(direct_count)
        for i in indices:
            item = direct_messages.nth(i)
            try:
                if not item.is_visible(timeout=250):
                    continue
            except Exception:
                continue

            current_msg_id = message_id_value(item)
            if current_msg_id > best_msg_id:
                best_msg_id = current_msg_id
                best_item = item

        if best_item is not None:
            return best_item

    candidates: list[Locator] = []
    seen_ids: set[int] = set()

    for selector in cfg.item_selector_candidates:
        scoped = section.locator(selector)
        try:
            count = min(scoped.count(), 25)
        except Exception:
            continue

        for i in range(count):
            item = scoped.nth(i)
            try:
                if not item.is_visible(timeout=250):
                    continue
            except Exception:
                continue

            try:
                handle = item.element_handle(timeout=500)
            except Exception:
                handle = None
            if handle is None:
                continue

            identity = id(handle)
            if identity in seen_ids:
                continue
            seen_ids.add(identity)

            text = locator_text(item)
            if len(text) < 10:
                continue
            candidates.append(item)

    if not candidates:
        return None

    candidates.sort(key=score_item, reverse=True)
    return candidates[0]


def click_best(locator: Locator) -> bool:
    try:
        locator.click(timeout=3000)
        return True
    except Exception:
        try:
            locator.scroll_into_view_if_needed(timeout=1000)
            locator.click(timeout=3000, force=True)
            return True
        except Exception:
            return False


def find_button_by_labels(scope: Locator | Page, labels: Iterable[str]) -> Locator | None:
    labels = list(labels)
    combined = "|".join(re.escape(label) for label in labels if label)
    if not combined:
        return None

    selectors = [
        "[role='button']",
        "button",
        "a",
        "[aria-label]",
        "[title]",
    ]

    for selector in selectors:
        locator = scope.locator(selector)
        try:
            count = min(locator.count(), 20)
        except Exception:
            continue

        for i in range(count):
            item = locator.nth(i)
            text = " ".join(
                value
                for value in [
                    locator_text(item),
                    attr(item, "aria-label"),
                    attr(item, "title"),
                ]
                if value
            )
            if text and re.search(combined, text, flags=re.IGNORECASE):
                return item

    return None


def copy_to_clipboard(value: str) -> None:
    subprocess.run(["pbcopy"], input=value, text=True, check=True)


def page_attr(page: Page, selector: str, name: str, timeout: int = 500) -> str:
    try:
        locator = page.locator(selector).first
        return locator.get_attribute(name, timeout=timeout) or ""
    except Exception:
        return ""


def extract_url_like_text(page: Page) -> str | None:
    candidates = [
        page.url,
        page_attr(page, "meta[property='og:url']", "content"),
        page_attr(page, "link[rel='canonical']", "href"),
    ]
    for candidate in candidates:
        if candidate and candidate.startswith("http"):
            return candidate
    return None


def try_copy_from_share_ui(page: Page, cfg: BotConfig) -> str | None:
    copy_button = find_button_by_labels(page, cfg.copy_button_labels)
    if copy_button and click_best(copy_button):
        time.sleep(1)
        try:
            clipboard_text = page.evaluate(
                """
                async () => {
                    try {
                        return await navigator.clipboard.readText();
                    } catch (error) {
                        return "";
                    }
                }
                """
            )
        except Exception:
            clipboard_text = ""
        if clipboard_text:
            return clipboard_text

    value = extract_url_like_text(page)
    if value:
        return value

    return None


def open_item(item: Locator, page: Page) -> bool:
    link = item.locator("a").first
    if link.count() and click_best(link):
        return True
    return click_best(item)


def share_current_item(page: Page, cfg: BotConfig) -> str | None:
    try:
        share_button = find_button_by_labels(page, cfg.share_button_labels)
    except re.error:
        share_button = None

    if share_button and click_best(share_button):
        time.sleep(1)
        return try_copy_from_share_ui(page, cfg)

    return extract_url_like_text(page)


def share_message_item(item: Locator, page: Page, cfg: BotConfig) -> str | None:
    try:
        message_wrap = resolve_message_wrap(item)
        message_id = message_wrap.get_attribute("data-msg-id", timeout=500) if message_wrap else ""
    except Exception:
        message_id = ""

    if message_id:
        return build_shared_chat_url(message_id)

    message_scope = message_wrap if message_wrap else item
    share_wrap = message_scope.locator(cfg.message_share_selector).first
    try:
        if share_wrap.count():
            item.hover(timeout=2000)
            share_wrap.scroll_into_view_if_needed(timeout=1000)
            if click_best(share_wrap):
                time.sleep(1)
                copied = try_copy_from_share_ui(page, cfg)
                if copied:
                    return copied
    except Exception:
        pass

    # If the widget share control fails, fall back to the page-level share handling.
    return share_current_item(page, cfg)


def bootstrap_context(playwright: Playwright, headed: bool) -> tuple[Browser, BrowserContext]:
    browser = playwright.chromium.launch(headless=not headed)
    context = browser.new_context(locale="he-IL")
    return browser, context


def wait_for_page_ready(page: Page) -> None:
    page.goto(SITE_URL, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except TimeoutError:
        pass


def soft_refresh_if_needed(page: Page) -> None:
    try:
        page.goto(SITE_URL, wait_until="domcontentloaded", timeout=60000)
    except TimeoutError:
        pass

    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except TimeoutError:
        pass


def main() -> int:
    args = parse_args()
    cfg = BotConfig(poll_seconds=args.poll_seconds, headed=args.headed)
    state = load_state(args.reset_state)
    last_seen_key = state.get("last_seen_key")
    stale_cycles = 0

    with sync_playwright() as playwright:
        browser, context = bootstrap_context(playwright, cfg.headed)
        page = context.new_page()

        try:
            wait_for_page_ready(page)
            print(f"Watching {cfg.site_url} every {cfg.poll_seconds} seconds")

            while True:
                feed_root = find_feed_root(page, cfg)
                if feed_root is None:
                    stale_cycles += 1
                    print("Chat section not found; retrying without reload...")
                    if stale_cycles >= cfg.stale_refresh_cycles:
                        print("Section has been missing for a while; refreshing the homepage.")
                        soft_refresh_if_needed(page)
                        stale_cycles = 0
                    time.sleep(cfg.poll_seconds)
                    continue

                item = newest_item(feed_root, cfg)
                if item is None:
                    stale_cycles += 1
                    print("No visible chat item found; waiting for the page to update...")
                    if stale_cycles >= cfg.stale_refresh_cycles:
                        print("Items still missing; refreshing the homepage.")
                        soft_refresh_if_needed(page)
                        stale_cycles = 0
                    time.sleep(cfg.poll_seconds)
                    continue

                stale_cycles = 0
                current_key = item_key(item)
                if not last_seen_key:
                    last_seen_key = current_key
                    save_state({"last_seen_key": last_seen_key})
                    print(f"Initialized last seen chat item: {current_key}")
                    time.sleep(cfg.poll_seconds)
                    continue

                if current_key == last_seen_key:
                    print("No new chat item.")
                    time.sleep(cfg.poll_seconds)
                    continue

                print(f"New chat item detected: {current_key}")
                copied = share_message_item(item, page, cfg)
                if copied:
                    copy_to_clipboard(copied)
                    print(f"Copied to clipboard: {copied}")
                    last_seen_key = current_key
                    save_state({"last_seen_key": last_seen_key, "last_copied": copied})
                else:
                    print("Detected new item, but failed to copy share value from the chat widget.")
                time.sleep(cfg.poll_seconds)

        except KeyboardInterrupt:
            print("Stopped by user.")
            return 0
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
