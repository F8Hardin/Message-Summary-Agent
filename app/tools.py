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
from bs4 import BeautifulSoup
import re

# Load categories for classification
with open(os.path.join(os.path.dirname(__file__), "../categories.json"), "r") as f:
    CATEGORY_DATA = json.load(f)

stored_emails = {} #all emails
#these can be removed once the agent returns them in a strucutred output
updated_UIDs = {} #emails that have been updated the current agent call
cleared_UIDs = set() #emails that the user wants cleared from the UI

def clean_text(text):
    return " ".join(text.split()) if text else ""

def clean_email_body_from_html(html: str) -> str:
    if not html:
        return "ERROR: HTML Body not received."

    soup = BeautifulSoup(html, "html.parser")

    # Remove script/style tags
    for tag in soup(["script", "style"]):
        tag.decompose()

    # Replace <br> and <p> with line breaks
    for br in soup.find_all(["br", "p"]):
        br.insert_before("\n")

    text = soup.get_text()
    text = re.sub(r"\n\s*\n+", "\n\n", text)  # collapse multiple blank lines
    return text.strip()


def extract_text_from_html(html):
    soup = BeautifulSoup(html, "html.parser")

    for script in soup(["script", "style"]):
        script.extract()

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

            if "attachment" in content_disposition.lower():
                continue

            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                decoded = payload.decode(errors="ignore")

                if content_type == "text/plain" and not plain_text:
                    plain_text = decoded.strip()
                elif content_type == "text/html" and not html_text:
                    html_text = decoded.strip()
            except Exception as e:
                print("Error decoding email part:", e)
    else:
        try:
            payload = msg.get_payload(decode=True)
            decoded = payload.decode(errors="ignore") if payload else ""
            return decoded.strip(), decoded.strip()  # both same if only one format exists
        except Exception:
            return "", ""

    return plain_text or "", html_text or ""

@tool
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
                    "date_time": msg.get("Date", "UNKNOWN")
                }

                stored_emails[uid] = email_data
                updated_UIDs[uid] = email_data
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
    
    return email

@tool
def get_email_by_title(title: str) -> dict:
    """
    Return full details for an email whose subject contains the given title (case-insensitive).

    This tool performs substring matching on the subject.
    If multiple emails match, it returns the first found.
    """
    #print(f"Searching for email with subject containing: {title}")
    matched_email = None
    for email in stored_emails.values():
        # Check if the provided title is a substring of the email subject
        if title.lower() in email["subject"].lower():
            matched_email = email
            break
    if not matched_email:
        return {"error": f"No email found with subject containing '{title}'."}
    return {
        "uid": matched_email["uid"],
        "subject": matched_email["subject"],
        "sender": matched_email["sender"],
        "isRead": matched_email.get("isRead", False),
        "summary": matched_email.get("summary"),
        "classification": matched_email.get("classification"),
        "body": matched_email["body"]
    }

@tool
def get_emails_by_sender(sender: str) -> list:
    """
    Return the UIDs of emails sent by the specified sender.

    This tool is useful for narrowing down emails from a particular person or service.
    It only returns UID values to conserve context space.

    To retrieve details (e.g., subject, body, summary), use `get_data_by_id` or related tools after obtaining UIDs.

    Example usage:
    - sender = "example@email.com"
    """
    return [
        email["uid"]
        for email in stored_emails.values()
        if email["sender"].lower() == sender.lower()
    ]

@tool
def get_emails_by_classification(priority: str = None, category: str = None) -> list:
    """
    Return the UID of emails matching a given priority and/or category.

    This tool helps filter stored emails by their classification fields without returning
    full content or headers, in order to minimize token usage and preserve context.

    Each result includes:
    - uid: The unique identifier of the email
    - classification: A dictionary with "priority" and "category" fields

    To retrieve full email data (such as subject, body, or summary), use tools like get_email_by_uid.

    Example usage:
    - priority="important"
    - category="work"
    - priority="not important", category="spam"
    """
    results = []
    for email in stored_emails.values():
        classification = email.get("classification", {})
        if (
            (priority is None or classification.get("priority") == priority) and
            (category is None or classification.get("category") == category)
        ):
            results.append({
                "uid": email["uid"],
            })
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
        "You will be given the plain-text content of an email. "
        "If the content is malformed, contains broken HTML, or lacks a clear message, "
        "DO NOT speculate. Just state 'The content could not be understood.' "
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
        updated_UIDs[uid] = email_obj
        stored_emails[uid] = email_obj
        return { "uid" : uid , "summary" : email_obj["summary"]}

    response = requests.post(
        os.environ["LMSTUDIO_URL"],
        headers={"Content-Type": "application/json"},
        json={
            "model": os.environ["OPENAI_MODEL"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"You are a helpful assistant that summarizes emails in plain English. Summarize the following email in 1–3 clear sentences. Do not include the original email text. Do not use any formatting like bullets or markdown. Return only the summary. Summarize the following email:\n\n{email_obj['body']}"}
            ],
            "temperature": 0,
            "max_tokens": 150,
        },
    )

    if not response.ok:
        print("Summarization failed:", response.status_code)
        return { "uid" : uid , "summary" : "Summarization failed: {response.status_code}"}

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        print("No summary returned.")
        return { "uid" : uid , "summary" : "No summary returned."}

    email_obj["summary"] = content.strip()
    updated_UIDs[uid] = email_obj
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
        updated_UIDs[uid] = email_obj
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

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    try:
        start = content.index("{")
        end = content.rindex("}") + 1
        classification = json.loads(content[start:end])
        email_obj["classification"] = classification
        updated_UIDs[uid] = email_obj
        stored_emails[uid] = email_obj
        return {
            "uid": uid,
            "classification": {
                "priority": classification.get("priority", "FAILED TO PARSE"),
                "category": classification.get("category", "FAILED TO PARSE")
            }
        }
    except Exception as e:
        print("Failed to parse classification:", e)
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
                updated_UIDs[uid] = stored_emails[uid]
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
                updated_UIDs[uid] = stored_emails[uid]
                return { "uid" : uid, "isRead" : stored_emails[uid]["isRead"]}
        return { "uid" : uid, "isRead" : "ERROR: Could not find Email."}
    except Exception as e:
        print("Error unmarking as read:", e)
        return { "uid": uid, "isRead": "UNKNOWN ERROR MARKING UNREAD" }

@tool
def get_last_updated_emails() -> list:
    """Return the the most recently updated emails from memory."""
    #print("Returning last updated emails...")
    return list(updated_UIDs.values())

@tool
def remove_email(uid: int) -> dict:
    """
    Remove an email from the stored emails by its UID.

    This tool deletes the specified email from the database,
    and updates the cleared_UIDs collection to track removed emails. It returns a
    structured response that includes the UID of the removed email. If the email is
    not found or an error occurs, an appropriate error message is returned.
    """
    #print("Attempting to remove email:", uid)
    try:
        removedEmail = stored_emails.pop(uid, None)
        if removedEmail:
            cleared_UIDs.add(uid)
            return { "uid" : uid }
        else:
            return { "uid" : "Failed to remove email. UID not found."}
    except Exception as e:
        return { "uid" : "Failed to remove email. Exception occurred." }

toolList = [
    fetch_emails,
    summarize_email,
    classify_email,
    mark_as_read,
    unmark_as_read,
    get_last_updated_emails,
    get_stored_email_with_uid,
    get_email_by_title,
    get_emails_by_classification,
    get_emails_by_sender,
    remove_email,
    get_data_by_id
]