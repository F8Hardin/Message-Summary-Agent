import Imap from 'imap-simple';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import quotedPrintable from 'quoted-printable';
const { decode } = quotedPrintable;

export async function fetchEmails() {
    console.log("Fetching unread emails...");
  
    const config = {
        imap: {
            user: process.env.EMAIL_USER,
            password: process.env.EMAIL_PASS,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 3000,
            tlsOptions: {
                rejectUnauthorized: false,
            }
        }
    };
  
    try {
        const connection = await Imap.connect(config);
        await connection.openBox('INBOX');
  
        const searchCriteria = ['UNSEEN'];
        const fetchOptions = { bodies: ['HEADER.FIELDS (SUBJECT)', 'TEXT'], struct: true };
  
        const messages = await connection.search(searchCriteria, fetchOptions);
        const emails = messages.map(msg => ({
            uid: msg.attributes.uid,
            subject: cleanText(msg.parts.find(part => part.which === 'HEADER.FIELDS (SUBJECT)').body.subject[0]),
            body: cleanEmailBody(msg.parts.find(part => part.which === 'TEXT').body),
        }));
  
        connection.end();
        console.log(`Retrieved ${emails.length} unread emails.`);
  
        return {
            count: emails.length,
            emails: emails.map(email => ({
                subject: email.subject,
                body: email.body,
                uid: email.uid,
                sender: "unknown",
              }))              
        };
    } catch (error) {
        console.error("Error fetching emails:", error);
        return { count: 0, emails: [] };
    }
}
  
export function cleanText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, " ").trim(); // ✅ Remove extra spaces
}
  
export function cleanEmailBody(emailBody) {
    if (!emailBody) return "";

    try {
        // Decode quoted-printable (e.g. =E2=80=99 → ’)
        emailBody = decode(emailBody).toString("utf8");
    } catch (e) {
        console.warn("Failed to decode quoted-printable:", e.message);
    }

    // Remove HTML tags
    emailBody = emailBody.replace(/<\/?[^>]+(>|$)/g, "");

    // Remove long MIME signatures and extra sections
    emailBody = emailBody.split("-- ").shift();
    emailBody = emailBody.split("Sent from my").shift();

    // Remove common reply markers
    const replyMarkers = [
        "On ", "wrote:", "From:", "Subject:", "To:", "Date:",
        "Original Message", "Begin forwarded message"
    ];
    for (const marker of replyMarkers) {
        const index = emailBody.indexOf(marker);
        if (index > 0) {
            emailBody = emailBody.substring(0, index);
            break;
        }
    }

    // Normalize whitespace and line breaks
    emailBody = emailBody.replace(/\r\n/g, "\n"); // Convert CRLF to LF
    emailBody = emailBody.replace(/\n{2,}/g, "\n\n"); // Collapse excessive line breaks
    emailBody = emailBody.replace(/[ \t]{2,}/g, " "); // Collapse excess spaces

    // Truncate if needed
    if (emailBody.length > 1000) {
        emailBody = emailBody.slice(0, 1000) + "...";
    }

    return emailBody.trim();
}
  
export async function summarizeMessage(messageBody) {
    console.log("📝 Summarizing message...");
  
    const response = await fetch(process.env.LMSTUDIO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL,
        messages: [
          { role: "system", content: "You are an email assistant that summarizes emails." },
          { role: "user", content: `Summarize the following email:\n\n${messageBody}` }
        ],
        temperature: 0,
        max_tokens: 150,
        stream: false
      }),
    });
  
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`❌ summarizeMessage request failed: ${response.status} ${errorText}`);
    }
  
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
  
    if (!content) {
      console.error("❌ No content returned from model:", data);
      return "Error: No summary generated.";
    }
  
    return content.trim();
}

export async function classifyMessage(messageBody) {
  console.log("📌 Classifying email...");

  const categoryData = JSON.parse(await fs.readFile('categories.json', 'utf-8'));
  const categories = categoryData.categories;
  const categoriesList = categories.map(c => `"${c}"`).join(', ');

  const systemPrompt = `
    You are an AI assistant that classifies emails.
    Classify the email into:
    - "priority": either "important" or "not important"
    - "category": one of the following: ${categoriesList}

    Return your response in JSON format like:
    {
    "priority": "important",
    "category": "work"
    }
    `;

    const response = await fetch(process.env.LMSTUDIO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL,
          messages: [
            { role: "system", content: "You are an email classification assistant." },
            { role: "user", content: "Classify the following email message." },
            { role: "assistant", content: "Please classify the email into priority and category." },
            { role: "user", content: systemPrompt + "\n\n" + messageBody }
          ],
          temperature: 0,
          max_tokens: 150,
        }),
      });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`❌ classifyMessage request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.error("❌ No classification content returned:", data);
    return { priority: "unknown", category: "uncategorized" };
  }

  try {
    const trimmed = content.trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}") + 1;
    const json = trimmed.slice(jsonStart, jsonEnd);
    return JSON.parse(json);
  } catch (err) {
    console.error("❌ Failed to parse classification:", err, "\nLLM response:", content);
    return {
      priority: "unknown",
      category: "uncategorized"
    };
  }
}
  
export async function markAsRead(emailUID) {
    console.log(`Attempting to mark email ${emailUID} as read...`);

    if (!emailUID) {
        console.error("Error: No UID provided for marking as read.");
        return;
    }

    const config = {
        imap: {
            user: process.env.EMAIL_USER,
            password: process.env.EMAIL_PASS,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 3000,
            tlsOptions: {
                rejectUnauthorized: false,
            },
        },
    };

    try {
        const connection = await Imap.connect(config);
        await connection.openBox('INBOX');

        console.log(`Checking if email with UID ${emailUID} exists...`);
        const searchCriteria = [emailUID];
        const fetchOptions = { bodies: [] };
        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            console.error(`❌ No matching email found for UID: ${emailUID}`);
            connection.end();
            return false;
        }

        console.log(`Email found. Adding "\\Seen" flag to mark as read...`);
        await connection.addFlags(emailUID, ['\\Seen']);

        connection.end();
        return true;
    } catch (error) {
        console.error("Error marking email as read:", error);
    }
}