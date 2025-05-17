import os
import imaplib
import email
from email.header import decode_header
from bs4 import BeautifulSoup
import json
import requests
import os
import random
from langchain.tools import tool
import re
import quopri

# Load categories for classification
with open(os.path.join(os.path.dirname(__file__), "../categories.json"), "r") as f:
    CATEGORY_DATA = json.load(f)

stored_emails = {} #all emails, acts as the database for now - updating this will replace with API calls to DB

def clean_text(text):
    return " ".join(text.split()) if text else ""

import re
from bs4 import BeautifulSoup, Comment

def clean_email_body_from_html(html: str) -> str:
    if not html:
        return "ERROR: HTML Body not received."
    
    soup = BeautifulSoup(html, "html.parser")

    # 1) Remove tags that are never useful
    for tag in soup(["script", "style", "head", "meta", "link"]):
        tag.decompose()

    # 2) Remove all images (including base64 inline)
    for img in soup.find_all("img"):
        img.decompose()

    # 3) Remove HTML comments
    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    # 4) Replace <br> and block tags with newlines
    for block in soup.find_all(["br", "p", "div", "li"]):
        block.insert_before("\n")

    # 5) Get text and collapse multiple blank lines
    text = soup.get_text()
    # Normalize whitespace
    text = re.sub(r"[ \t]+", " ", text)
    # Collapse more than 2 newlines
    text = re.sub(r"\n{3,}", "\n\n", text)
    
    # 6) Strip leading/trailing whitespace
    return text.strip()

def extract_text_from_html(html: str) -> str:
    if not html:
        return ""

    soup = BeautifulSoup(html, "html.parser")

    # Remove scripts/styles/comments as above
    for tag in soup(["script", "style", "head", "meta", "link", "img"]):
        tag.decompose()
    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    # Get text with single-space separation
    text = soup.get_text(separator=" ")
    text = re.sub(r"\s+", " ", text).strip()
    return text

def extract_email_parts(msg):
    plain_text = None
    html_text = None

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = part.get("Content-Disposition", "")

            # skip attachments
            if "attachment" in content_disposition.lower():
                continue

            try:
                # HTML branch unchanged
                if content_type == "text/html" and not html_text:
                    raw = part.get_payload(decode=True) or b""
                    html_text = raw.decode(part.get_content_charset() or "utf-8", errors="ignore").strip()

                # new plain‐text branch
                elif content_type == "text/plain" and not plain_text:
                    cte = part.get("Content-Transfer-Encoding", "").lower()
                    raw_payload = part.get_payload(decode=False) or b""
                    if "quoted-printable" in cte:
                        decoded_bytes = quopri.decodestring(raw_payload)
                    else:
                        decoded_bytes = part.get_payload(decode=True) or b""
                    charset = part.get_content_charset() or "utf-8"
                    plain_text = decoded_bytes.decode(charset, errors="replace").strip()

            except Exception as e:
                print("Error decoding email part:", e)

    else:
        # single‐part fallback stays the same
        try:
            payload = msg.get_payload(decode=True) or b""
            decoded = payload.decode(msg.get_content_charset() or "utf-8", errors="ignore")
            return decoded.strip(), decoded.strip()
        except Exception:
            return "", ""

    # final fallback: if no plain_text but have html_text, strip tags
    if not plain_text and html_text:
        soup = BeautifulSoup(html_text, "html.parser")
        plain_text = soup.get_text(separator="\n").strip()

    return plain_text or "", html_text or ""

@tool #removed as tool
def fetch_emails() -> dict:
    """
    Fetch new, unread emails and store them in memory.

    Only unseen emails are fetched. The returned list contains minimal metadata,
    omitting the full email body to preserve token context. Use `get_email_by_uid`
    or similar tools to retrieve full content later.
    """
    print("Fetching unread emails...")
    emails = []
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(os.environ["EMAIL_USER"], os.environ["EMAIL_PASS"])
        mail.select("inbox")

        status, messages = mail.search(None, "UNSEEN")
        message_ids = messages[0].split()

        for uid_bytes in message_ids:
            uid = int(uid_bytes)
            if uid in stored_emails:
                continue

            res, msg_data = mail.fetch(str(uid), "(BODY.PEEK[])")
            for part in msg_data:
                if not isinstance(part, tuple):
                    continue

                msg = email.message_from_bytes(part[1])
                subject, encoding = decode_header(msg.get("Subject", ""))[0]
                if isinstance(subject, bytes):
                    subject = subject.decode(encoding or "utf-8", errors="ignore")

                plainTextBody, rawHtmlbody = extract_email_parts(msg)

                email_data = {
                    "uid": uid,
                    "subject": clean_text(subject),
                    "body": clean_email_body_from_html(plainTextBody),
                    "raw_body": rawHtmlbody,
                    "sender": msg.get("From", "unknown"),
                    "summary": None,
                    "classification": {"priority": None, "category": None},
                    "isRead": False,
                    "dateTime": msg.get("Date", "UNKNOWN")
                }

                stored_emails[uid] = email_data
                emails.append(email_data)

        mail.logout()
    except Exception as e:
        print("Error fetching emails:", e)

    return {
        "new_email_data": [
            {
                "uid": e["uid"],
                "subject": e["subject"],
                "sender": e["sender"],
                "isRead": e.get("isRead", False),
                "summary": e.get("summary"),
                "classification": e.get("classification")
            } for e in emails
        ]
    }

def get_stored_emails() -> list:
    """Return a list of all stored emails in memory.

    Each entry includes minimal identifying info: UID, subject, sender, read status, and classification.
    The full email body is not included to conserve context.

    Use `get_email_by_uid` or related tools to retrieve the full content when needed.
    """
    print("Returning stored emails...")
    return [
        email
        for email in stored_emails.values()
    ]

@tool
def get_stored_email_with_uid(uid: int) -> dict:
    """Return full details for a stored email by UID.

    This includes subject, sender, read status, summary, classification, and full body content.
    Use this when the user asks to see an email or when full analysis is needed.
    """
    #print(f"Fetching email with UID: {uid}...")
    email = stored_emails.get(uid)
    if not email:
        return {"error": f"No email found with UID {uid}"}
    
    return {
        "uid":            email["uid"],
        "subject":        email["subject"],
        "sender":         email["sender"],
        "body":           email["body"],
        "summary":        email["summary"],
        "classification": email["classification"],
        "isRead":         email["isRead"],
    }

@tool
def get_emails_by_data(field: str, query: str) -> dict:
    """
    When a user asks for emails of a certain criteria call this function.

    Return a dictionary mapping email UIDs to their field values for all emails
    where the specified field contains the given query (case-insensitive).

    For each email, the value is obtained by:
       value = email.get(field, "")
    If the value is a dictionary, it is converted to a space-separated string of its values.
    All comparisons are performed in lowercase.

    Parameters:
        field (str): The name of the field to search (e.g., "subject", "sender", "summary", "classification").
        query (str): The query string to search for as a substring.

    Returns:
        dict: A dictionary mapping matching email UIDs to the field value that matched.
    
    Example:
        If an email has subject "Meeting with Robinhood Updates" and you call:
            get_email_by_data("subject", "robinhood")
        It might return: { 103: "meeting with robinhood updates" }
    """
    print("Getting emails by data:", field, ":", query)
    query = query.lower().strip()
    results = {}
    for email in stored_emails.values():
        value = email.get(field, "")
        if isinstance(value, dict):
            value_str = " ".join([str(v) for v in value.values()])
        else:
            value_str = str(value)
        value_str_lower = value_str.lower().strip()
        if query in value_str_lower:
            results[email["uid"]] = value
    return results

@tool
def get_data_by_id(uid: int, field: str) -> dict:
    """
    Retrieve a specific field (e.g., summary, classification, body) from an email by UID.

    This tool allows precise access to a single data field for a given email. Use this when
    you already know the UID and want to reduce context usage by retrieving only the requested value.

    Valid field options include:
    - "subject"
    - "sender"
    - "summary"
    - "classification"
    - "body" (cleaned)
    - "body_html" (original HTML)
    - "isRead"
    - "date_time"

    Returns:
    {
        "uid": 1234,
        "field": "summary",
        "value": "This is a summarized version of the email."
    }

    Use this after filtering with tools like `get_emails_by_classification` or `get_emails_by_sender`.
    """
    email = stored_emails.get(uid)
    if not email:
        return {"uid": uid, "field": field, "value": "Email not found."}
    
    value = email.get(field, f"Field '{field}' not found in email.")
    return {"uid": uid, "field": field, "value": value}

@tool #removed as tool
def get_stored_email_uids() -> list:
    """
    Return a list of UIDs for all stored emails in memory.

    This tool returns only the unique identifiers (UIDs) of the emails,
    so that the agent can use these UIDs to retrieve specific email data
    via other tools (e.g., get_data_by_id).

    Example return value:
    [101, 102, 103, ...]
    """
    print("Returning stored email UIDs...")
    return list(stored_emails.keys())

@tool
def summarize_email(uid: int) -> dict:
    """
    Summarize a single email by its UID and store the result in the database.

    This tool operates on one email at a time. The summary is stored persistently with the email data,
    and the tool also returns a structured response with the UID and generated summary.

    To summarize all emails, first retrieve UIDs using get_stored_emails,
    then call summarize_email individually for each.
    """
    #print(f"Summarizing message with UID: {uid}...")

    system_prompt = (
        "You are an email summarization assistant. "
        "You will be given an email. "
        "Summarize the main content of the email."
        "If unable to summarize - DO NOT speculate. Just state 'The content could not be understood.' "
        "Otherwise, summarize the key points in 2-3 sentences."
    )

    email_obj = stored_emails.get(uid)
    #print("Summarizing an email:", email_obj)
    if not email_obj:
        print("Email not found.")
        return { "uid" : uid , "summary" : "Email not found"}
    
    print(f"Summarizing body (truncated): {email_obj['body'][:250]}...")
    
    test_summary = os.getenv("TEST_SUMMARY", "false").lower() in ("true", "1", "yes")
    if test_summary:
        email_obj["summary"] = "This is a test summary"
        stored_emails[uid] = email_obj
        return { "uid" : uid , "summary" : email_obj["summary"]}

    response = requests.post(
        os.environ["LMSTUDIO_URL"],
        headers={"Content-Type": "application/json"},
        json={
            "model": os.environ["OPENAI_MODEL"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Summarize the following email:\n\n{email_obj['body']}"}
            ],
            "temperature": 0,
            "max_tokens": 150,
        },
    )

    if not response.ok:
        print("Summarization FAILED:", response.json())
        return { "uid" : uid , "summary" : "Summarization failed: {response.status_code}"}

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        print("No summary returned.")
        return { "uid" : uid , "summary" : "No summary returned."}

    email_obj["summary"] = content.strip()
    stored_emails[uid] = email_obj
    print("Successfully summarized.")
    return { "uid" : uid , "summary" : email_obj["summary"]}

@tool
def classify_email(uid: int) -> dict:
    """
    Classify a single email by its UID and store the classification in the database.

    This tool assigns a priority (e.g., important or not important) and a category (e.g., work, hobby),
    and stores the result alongside the email data.

    The tool also returns a structured response with the UID and classification details.
    To classify all emails, retrieve UIDs using get_stored_emails and call this tool for each one.
    """
    #print(f"Classifying email with UID: {uid}...")

    email_obj = stored_emails.get(uid)
    #print("Classifying an email:", email_obj)
    if not email_obj:
        print("Email not found.")
        return { "uid" : uid , "classification" : { "priority" : "Email not found", "category" : "Email not found"}}
    
    test_classification = os.getenv("TEST_CLASSIFICATION", "false").lower() in ("true", "1", "yes")
    if test_classification:
        priority = random.choice(["important", "not important"])
        category = random.choice(CATEGORY_DATA["categories"])

        email_obj["classification"] = {
            "priority": priority,
            "category": category
        }
        stored_emails[uid] = email_obj
        return { "uid" : uid , "classification" : { "priority" : priority, "category" : category}}

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

    
    if not response.ok:
        print("Classification FAILED:", response)
        return { "uid" : uid , "classification" : { "priority" : "FAILED", "category" : "FAILED"}}

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    try:
        start = content.index("{")
        end = content.rindex("}") + 1
        classification = json.loads(content[start:end])
        email_obj["classification"] = classification
        stored_emails[uid] = email_obj
        return {
            "uid": uid,
            "classification": {
                "priority": classification.get("priority", "FAILED TO PARSE"),
                "category": classification.get("category", "FAILED TO PARSE")
            }
        }
    except Exception as e:
        print("Classification FAILED:", e)
        print("Classification response:", response.json())
        return { "uid" : uid , "classification" : { "priority" : "FAILED TO PARSE", "category" : "FAILED TO PARSE"}}

@tool
def mark_as_read(uid: int) -> dict:
    """
    Mark an email as read using its UID and update the database.

    This tool updates the read status of the specified email both in memory and on the mail server.
    It returns a structured response indicating the UID and new `isRead` status.
    """
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
                return { "uid" : uid, "isRead" : stored_emails[uid]["isRead"]}
        return { "uid" : uid, "isRead" : "ERROR: Could not find Email."}
    except Exception as e:
        print("Error marking as read:", e)
        return { "uid" : uid, "isRead" : "UNKNOWN ERROR MARKING READ"}
    
@tool
def unmark_as_read(uid: int) -> dict:
    """
    Mark an email as unread using its UID and update the database.

    This tool reverses the read status for a given email both in memory and on the mail server.
    It returns a structured response with the UID and updated `isRead` value.
    """
    #print(f"Unmarking email {uid} as read...")
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(os.environ["EMAIL_USER"], os.environ["EMAIL_PASS"])
        mail.select("inbox")

        result = mail.store(str(uid), "-FLAGS", "\\Seen")
        mail.logout()

        if result[0] == "OK":
            if uid in stored_emails:
                stored_emails[uid]["isRead"] = False
                return { "uid" : uid, "isRead" : stored_emails[uid]["isRead"]}
        return { "uid" : uid, "isRead" : "ERROR: Could not find Email."}
    except Exception as e:
        print("Error unmarking as read:", e)
        return { "uid": uid, "isRead": "UNKNOWN ERROR MARKING UNREAD" }

@tool
def remove_email(uid: int) -> dict:
    """
    Remove an email from the stored emails by its UID.

    This tool deletes the specified email from the database,
    and the tool call is checked on the frontend to track removed emails. It returns a
    structured response that includes the UID of the removed email. If the email is
    not found or an error occurs, an appropriate error message is returned.
    """
    #print("Attempting to remove email:", uid)
    try:
        removedEmail = stored_emails.pop(uid, None)
        if removedEmail:
            return { "uid" : uid }
        else:
            return { "uid" : "Failed to remove email. UID not found."}
    except Exception as e:
        return { "uid" : "Failed to remove email. Exception occurred." }

toolList = [
    summarize_email,
    classify_email,
    mark_as_read,
    unmark_as_read,
    get_stored_email_with_uid,
    get_emails_by_data,
    remove_email,
    get_data_by_id
]