import os
import imaplib
import email
from email.header import decode_header
from bs4 import BeautifulSoup
import json
import requests
import os
from langchain.tools import tool

# Load categories for classification
with open(os.path.join(os.path.dirname(__file__), "../categories.json"), "r") as f:
    CATEGORY_DATA = json.load(f)

stored_emails = {}
updated_UIDs = {}

def clean_text(text):
    return " ".join(text.split()) if text else ""

def clean_email_body(body):
    if not body:
        return ""

    try:
        body = email.quoprimime.body_decode(body).decode("utf-8")
    except Exception:
        pass

    soup = BeautifulSoup(body, "html.parser")
    text = soup.get_text()

    return text.strip()[:1000]

@tool
def fetch_emails():
    """Fetch unread emails from the inbox and store only new emails in memory."""
    print("Fetching unread emails...")
    emails = []
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(os.environ["EMAIL_USER"], os.environ["EMAIL_PASS"])
        mail.select("inbox")

        status, messages = mail.search(None, "UNSEEN")
        message_ids = messages[0].split()

        for uid in message_ids:
            uid_int = int(uid)
            if uid_int in stored_emails:
                print(f"Email UID {uid_int} already fetched. Skipping.")
                continue  # Skip if already stored

            res, msg_data = mail.fetch(uid, "(BODY.PEEK[])")
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject = decode_header(msg["Subject"])[0][0]
                    if isinstance(subject, bytes):
                        subject = subject.decode()

                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            content_type = part.get_content_type()
                            if content_type == "text/plain":
                                body = part.get_payload(decode=True).decode(errors="ignore")
                                break
                    else:
                        body = msg.get_payload(decode=True).decode(errors="ignore")

                    email_data = {
                        "uid": uid_int,
                        "subject": clean_text(subject),
                        "body": clean_email_body(body),
                        "sender": msg["From"] or "unknown",
                        "summary": None,
                        "classification": {"priority": None, "category": None},
                        "isRead": False
                    }

                    stored_emails[uid_int] = email_data
                    emails.append(email_data)

        mail.logout()
    except Exception as e:
        print("Error fetching emails:", e)
    return {"count": len(emails), "emails": emails}

@tool
def get_stored_emails():
    """Return all emails currently stored in memory.
    
    This tool returns every email that has been fetched,
    regardless of when it was fetched or if it has already
    been processed (summarized or classified). Use this tool
    to list all available emails for further processing.
    """
    print("Returning stored emails...")
    return list(stored_emails.values())


@tool
def summarize_email(uid: int) -> bool:
    """
    Summarize a single email by its UID and store summary.

    Note: This tool operates on one email at a time. To summarize all emails,
    first retrieve all stored emails using the get_stored_emails tool, then
    run summarize_email for each email's UID.
    """
    print(f"Summarizing message with UID: {uid}...")

    email_obj = stored_emails.get(uid)
    print("Summarizing an email:", email_obj)
    if not email_obj:
        print("Email not found.")
        return False
    
    test_summary = os.getenv("TEST_SUMMARY", "false").lower() in ("true", "1", "yes")
    if test_summary:
        email_obj["summary"] = "This is a test summary"
        updated_UIDs[uid] = email_obj
        stored_emails[uid] = email_obj
        return True

    response = requests.post(
        os.environ["LMSTUDIO_URL"],
        headers={"Content-Type": "application/json"},
        json={
            "model": os.environ["OPENAI_MODEL"],
            "messages": [
                {"role": "system", "content": "You are an email assistant that summarizes emails."},
                {"role": "user", "content": f"Summarize the following email:\n\n{email_obj['body']}"}
            ],
            "temperature": 0,
            "max_tokens": 150,
        },
    )

    if not response.ok:
        print("Summarization failed:", response.status_code)
        return False

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        print("No summary returned.")
        return False

    email_obj["summary"] = content.strip()
    print("Successfully summarized.")
    return True

@tool
def classify_email(uid: int) -> bool:
    """
    Classify a single email by its UID and store its priority and category.

    Note: This tool operates on one email at a time. To classify all emails,
    first retrieve all stored emails using the get_stored_emails tool, then
    run classify_email for each email's UID.
    """
    print(f"Classifying message with UID: {uid}...")

    email_obj = stored_emails.get(uid)
    print("Classifying an email:", email_obj)
    if not email_obj:
        print("Email not found.")
        return False
    
    test_classification = os.getenv("TEST_CLASSIFICATION", "false").lower() in ("true", "1", "yes")
    if test_classification:
        email_obj["classification"] = {"priority": "important", "category": "test"}
        updated_UIDs[uid] = email_obj
        stored_emails[uid] = email_obj
        return True

    categories = CATEGORY_DATA["categories"]
    category_list = ", ".join(f'"{c}"' for c in categories)

    system_prompt = f"""
    You are an AI assistant that classifies emails.
    Classify the email into:
    - \"priority\": either \"important\" or \"not important\"
    - \"category\": one of the following: {category_list}

    Return your response in JSON format like:
    {{
      \"priority\": \"important\",
      \"category\": \"work\"
    }}
    """

    response = requests.post(
        os.environ["LMSTUDIO_URL"],
        headers={"Content-Type": "application/json"},
        json={
            "model": os.environ["OPENAI_MODEL"],
            "messages": [
                {"role": "system", "content": "You are an email classification assistant."},
                {"role": "user", "content": system_prompt + "\n\n" + email_obj["body"]}
            ],
            "temperature": 0,
            "max_tokens": 150,
        },
    )

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    try:
        start = content.index("{")
        end = content.rindex("}") + 1
        classification = json.loads(content[start:end])
        email_obj["classification"] = classification
        return True
    except Exception as e:
        print("Failed to parse classification:", e)
        return False

@tool
def mark_as_read(uid: int) -> bool:
    """Mark an email as read using its UID and update stored_emails."""
    print(f"Marking email {uid} as read...")
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(os.environ["EMAIL_USER"], os.environ["EMAIL_PASS"])
        mail.select("inbox")

        result = mail.store(str(uid), "+FLAGS", "\\Seen")
        mail.logout()

        if result[0] == "OK":
            if uid in stored_emails:
                stored_emails[uid]["isRead"] = True
                updated_UIDs[uid] = stored_emails[uid]
            return True
        return False
    except Exception as e:
        print("Error marking as read:", e)
        return False

@tool
def get_last_updated_emails():
    """Return the the most recently updated emails from memory."""
    print("Returning last updated emails...")
    return list(updated_UIDs.values())

toolList = [
    fetch_emails,
    get_stored_emails,
    summarize_email,
    classify_email,
    mark_as_read,
    get_last_updated_emails
]