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

# Load categories for classification
with open(os.path.join(os.path.dirname(__file__), "../categories.json"), "r") as f:
    CATEGORY_DATA = json.load(f)

stored_emails = {} #all emails
updated_UIDs = {} #emails that have been updated the current agent call
cleared_UIDs = set() #emails that the user wants cleared from the UI

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
def fetch_emails() -> dict:
    """Fetches new, unread emails and stores them in the backend database. 
    Only new emails are retrieved. The tool returns a list of these newly fetched emails 
    **without their full body content** to reduce context usage. 
    To access full content later, use the get_email_by_uid or get_email_by_title tools."""
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
                        "isRead": False,
                        "date_time": ...
                    }

                    stored_emails[uid_int] = email_data
                    updated_UIDs[uid_int] = email_data
                    emails.append(email_data)

        mail.logout()
    except Exception as e:
        print("Error fetching emails:", e)

    emails_without_body = [
        {
            "uid": e["uid"],
            "subject": e["subject"],
            "sender": e["sender"],
            "isRead": e.get("isRead", False),
            "summary": e.get("summary"),
            "classification": e.get("classification")
        }
        for e in emails
    ]
    return {"new_email_data": emails_without_body}

@tool
def get_stored_emails() -> list:
    """Return a list of all stored emails in memory.

    Each entry includes minimal identifying info: UID, subject, sender, read status, and classification.
    The full email body is not included to conserve context.

    Use `get_email_by_uid` or related tools to retrieve the full content when needed.
    """
    print("Returning stored email headers...")
    return [
        {
            "uid": email["uid"],
            "subject": email["subject"],
            "sender": email["sender"],
            "isRead": email.get("isRead", False),
            "classification": email.get("classification")
        }
        for email in stored_emails.values()
    ]

@tool
def get_stored_email_with_uid(uid: int) -> dict:
    """Return full details for a stored email by UID.

    This includes subject, sender, read status, summary, classification, and full body content.
    Use this when the user asks to see an email or when full analysis is needed.
    """
    print(f"Fetching email with UID: {uid}...")
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
    print(f"Searching for email with subject containing: {title}")
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
    """Return a list of emails sent by the specified sender.

    Returns subject, sender, summary, classification, isRead status, and full body.
    """
    print(f"Fetching emails from sender: {sender}")
    return [
        email
        for email in stored_emails.values()
        if email["sender"].lower() == sender.lower()
    ]

@tool
def get_emails_by_classification(priority: str = None, category: str = None) -> list:
    """Return emails matching a classification priority and/or category.

    Returns subject, sender, summary, classification, isRead status, and full body.

    Example: priority="important", category="work"
    """
    print(f"Filtering emails by classification: priority={priority}, category={category}")
    results = []
    for email in stored_emails.values():
        classification = email.get("classification", {})
        if (
            (priority is None or classification.get("priority") == priority) and
            (category is None or classification.get("category") == category)
        ):
            results.append(email)
    return results

@tool
def summarize_email(uid: int) -> dict:
    """
    Summarize a single email by its UID and store the result in the database.

    This tool operates on one email at a time. The summary is stored persistently with the email data,
    and the tool also returns a structured response with the UID and generated summary.

    To summarize all emails, first retrieve UIDs using get_stored_emails,
    then call summarize_email individually for each.
    """
    print(f"Summarizing message with UID: {uid}...")

    email_obj = stored_emails.get(uid)
    print("Summarizing an email:", email_obj)
    if not email_obj:
        print("Email not found.")
        return { "uid" : uid , "summary" : "Email not found"}
    
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
                {"role": "system", "content": "You are an email assistant that summarizes emails."},
                {"role": "user", "content": f"Summarize the following email:\n\n{email_obj['body']}"}
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
    print(f"Classifying email with UID: {uid}...")

    email_obj = stored_emails.get(uid)
    print("Classifying an email:", email_obj)
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
    print(f"Unmarking email {uid} as read...")
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
    print("Returning last updated emails...")
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
    print("Attempting to remove email:", uid)
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
    get_stored_emails,
    summarize_email,
    classify_email,
    mark_as_read,
    unmark_as_read,
    get_last_updated_emails,
    get_stored_email_with_uid,
    get_email_by_title,
    get_emails_by_classification,
    get_emails_by_sender,
    remove_email
]