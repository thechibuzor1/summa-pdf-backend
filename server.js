require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const pdfParse = require("pdf-parse");

const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const fs = require("fs");
const mammoth = require("mammoth");
const textract = require("textract");
const pdfjsLib = require("pdfjs-dist");
const axios = require("axios"); 

const app = express();
const port = process.env.PORT || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const cache = new Map();

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\n+/g, "\n")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/\•|\/g, "- ")
    .replace(/([.,;:])([^\s])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}


async function isScannedPDF(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({
    data: uint8Array,
    standardFontDataUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/",
  }).promise;

  const pageChecks = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pageChecks.push(pdf.getPage(i).then(page => page.getTextContent()));
  }

  const results = await Promise.all(pageChecks);
  return results.every(content => content.items.length === 0);
}


async function extractTextPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text ? data.text.trim() : "";
  } catch (error) {
    console.error("Error extracting text from PDF:", error);
    return "";
  }
}

async function extractTextFromImages(imageBuffer) {
  try {
    // Ensure buffer contains an actual image
    const metadata = await sharp(imageBuffer).metadata();
    if (!metadata.format) {
      throw new Error("Unsupported image format");
    }

    // Process image for better OCR accuracy
    const processedImageBuffer = await sharp(imageBuffer)
      .resize({ width: 1024 })
      .grayscale()
      .normalize()
      .toFormat("png") // Ensure it's in a supported format
      .toBuffer();

    const tempImagePath = `./temp_images/ocr_${Date.now()}.png`;
    fs.writeFileSync(tempImagePath, processedImageBuffer);

    // Run OCR
    const { data } = await Tesseract.recognize(tempImagePath, "eng");
    fs.unlinkSync(tempImagePath);

    return data.text ? data.text.trim() : "";
  } catch (error) {
    console.error("Error in OCR:", error.message);
    return "";
  }
}


async function extractTextDOCX(buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return value ? value.trim() : "";
  } catch (error) {
    console.error("Error extracting text from DOCX:", error);
    return "";
  }
}


async function extractTextFromOtherDocs(filePath) {
  return new Promise((resolve, reject) => {
    textract.fromFileWithPath(filePath, (error, text) => {
      if (error) {
        console.error("Error extracting text:", error);
        reject(error);
      } else {
        resolve(text ? text.trim() : "");
      }
    });
  });
}

async function generateSummaryWithGemini(text) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
                You are an expert educator. Generate a **detailed study guide, quiz set, and flashcards** from the provided document.
                **Prioritize quizzes and flashcards** while keeping summaries concise.

                ### **Expected JSON Response Format:**
                \`\`\`json
                {
                  "summary": { "key_points": ["Point 1", "Point 2"] },
                  "flashcards": [ { "term": "Concept", "definition": "Explanation" } ],
                  "quiz": {
                    "questions": [
                      {
                        "question": "What is XYZ?",
                        "type": "multiple_choice",
                        "options": ["A", "B", "C", "D"],
                        "answer": "B",
                        "explanation": "Why B is correct."
                      }
                    ]
                  },
                  "study_guide": {
                    "sections": [
                      {
                        "title": "Topic",
                        "summary": "Short explanation",
                        "comparisons": [{ "concept_a": "A", "concept_b": "B", "difference": "How they differ" }],
                        "real_world_applications": ["Example 1", "Example 2"],
                        "common_misconceptions": [{ "misunderstanding": "X", "clarification": "Y" }]
                      }
                    ]
                  }
                }
                \`\`\`

                ### **Document Content:**
                ${text.substring(0, 30000)}
              `
              }
            ]
          }
        ]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    return response.data;
  } catch (error) {
    console.error("Error with Gemini API:", error.response ? error.response.data : error.message);
    return null;
  }
}

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const buffer = req.file.buffer;
    const fileName = req.file.originalname.toLowerCase();
    const tempFilePath = `./temp_docs/${Date.now()}_${fileName}`;
    fs.writeFileSync(tempFilePath, buffer);

    let extractedText = "";

    if (fileName.endsWith(".pdf")) {
      const isScanned = await isScannedPDF(buffer);
      extractedText = isScanned ? await extractTextFromImages(buffer) : await extractTextPDF(buffer);
    } else if (fileName.endsWith(".docx")) {
      extractedText = await extractTextDOCX(buffer);
    } else {
      extractedText = await extractTextFromOtherDocs(tempFilePath);
    }

    fs.unlinkSync(tempFilePath);

    const cleanedText = cleanText(extractedText);
    if (!cleanedText) {
      return res.status(400).json({ error: "No extractable text found" });
    }

    if (cache.has(cleanedText)) {
      return res.json({ summary: cache.get(cleanedText) });
    }

    const summary = await generateSummaryWithGemini(cleanedText);
    if (!summary) {
      return res.status(500).json({ error: "Failed to generate summary with Gemini." });
    }

    cache.set(cleanedText, summary);
    res.json({ summary });
  } catch (error) {
    console.error("Error processing document:", error.message);
    res.status(500).json({ error: error.message });
  }
});


app.post("/ask", async (req, res) => {
  const { query, context } = req.body;

  if (!query || !context) {
    return res.status(400).json({ error: "Query and context are required." });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
                      You are an expert educator and AI study assistant, dedicated to helping users learn efficiently. Your goal is to provide **concise, accurate, and well-explained** answers while maintaining clarity and depth.  

                      ### **Guidelines:**  
                      - **Explain concepts thoroughly** but in a **clear and structured** manner.  
                      - If the user provides study material, **prioritize answering based on it** while adding helpful context if needed.  
                      - If information is missing, **use general knowledge and, if necessary, search for reliable sources** to provide a complete answer.  
                      - Adapt responses based on the user's level (beginner, intermediate, advanced).  
                      - Use **examples, analogies, or step-by-step breakdowns** when necessary to enhance understanding.  
                      - Keep responses **concise and free from unnecessary filler** while ensuring completeness.  

                      **User Query:** ${query}  
                      **Study Context:** ${context}  

                      `
              }
            ]
          }
        ]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't process your question. Try again!";

    res.json({ response: aiResponse });
  } catch (error) {
    console.error("Error with Gemini API:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch response from AI." });
  }
});

app.post("/flashcards", async (req, res) => {
  const { context } = req.body;

  if (!context) {
    return res.status(400).json({ error: "Context is required to generate flashcards." });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
                You are an AI flashcard generator. Based on the provided study context, generate **detailed, intuitive, and comprehensive** flashcards.  
                
                - **If the context lacks sufficient information, search the web** for the most relevant details.  
                - Ensure **each flashcard is clear and useful for memorization.**  
                - Provide **as many flashcards as possible.**  

                ### **Format Response as JSON**
                \`\`\`json
                {
                  "flashcards": [
                    { "term": "Concept", "definition": "Explanation" },
                    { "term": "Concept 2", "definition": "Explanation 2" }
                  ]
                }
                \`\`\`

                ### **Context Provided:**
                ${context}
              `
              }
            ]
          }
        ]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const flashcards = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!flashcards) {
      return res.status(500).json({ error: "Failed to generate flashcards." });
    }

    res.json({ flashcards });
  } catch (error) {
    console.error("Error generating flashcards:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate flashcards." });
  }
});

app.post("/quiz", async (req, res) => {
  const { context } = req.body;

  if (!context) {
    return res.status(400).json({ error: "Context is required to generate quiz questions." });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
                You are an AI exam quiz generator. Your task is to create a **comprehensive set of exam-level questions** based on the given topic.  

                - **Always search the web for additional exam-style questions** to ensure depth and coverage.  
                - **Prioritize well-structured, challenging questions** that assess conceptual understanding.  
                - **Include only automatically gradable question formats:**  
                  - **Multiple-Choice Questions (MCQ):** 4 choices, 1 correct answer.  
                  - **True/False Questions:** Clearly state the correct answer.  
                  - **Fill-in-the-Blank Questions:** Ensure a single correct answer.  

                - **Ensure variety and generate as many questions as possible.**  
                - **Provide the output in a structured JSON format.**  

                 **Output Format (JSON):**
                \`\`\`json
                {
                  "quiz": [
                    {
                      "type": "mcq",
                      "question": "Which principle explains X?",
                      "choices": ["Principle A", "Principle B", "Principle C", "Principle D"],
                      "correctAnswer": "Principle B"
                    },
                    {
                      "type": "true_false",
                      "question": "Statement about Y.",
                      "correctAnswer": "False"
                    },
                    {
                      "type": "fill_in_blank",
                      "question": "The process of Z is called _______.",
                      "correctAnswer": "Z-Process"
                    }
                  ]
                }
                \`\`\`

                **IMPORTANT:**
                - **For MCQs, always return the full text of the correct answer.** Do NOT return just a letter like "A" or "B".
                - **Ensure all questions and answers are clear, unambiguous, and structured properly.**
                
                **Topic Provided:**
                ${context}
              `
              }
            ]
          }
        ]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const quiz = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!quiz) {
      return res.status(500).json({ error: "Failed to generate quiz." });
    }

    res.json({ quiz });
  } catch (error) {
    console.error("Error generating quiz:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate quiz." });
  }
});

app.post("/explain", async (req, res) => {
  const { question, correctAnswer } = req.body;

  if (!question || !correctAnswer) {
    return res.status(400).json({ error: "Question and correct answer are required for explanation." });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
                You are an AI tutor. Your task is to explain the answer to a quiz question **in a clear, detailed, and educational manner**.

                - **Break down the key concepts behind the correct answer.**  
                - **Use simple and structured explanations to enhance understanding.**  
                - **Provide examples, analogies, or step-by-step reasoning when applicable.**  
                - **Ensure the explanation is concise but informative.**  

                **Question:** ${question}  
                **Correct Answer:** ${correctAnswer}  

                **Provide the explanation below:**
              `
              }
            ]
          }
        ]
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const explanation = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!explanation) {
      return res.status(500).json({ error: "Failed to generate explanation." });
    }

    res.json({ explanation });
  } catch (error) {
    console.error("Error generating explanation:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate explanation." });
  }
});





app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  if (!fs.existsSync("./temp_images")) fs.mkdirSync("./temp_images");
  if (!fs.existsSync("./temp_docs")) fs.mkdirSync("./temp_docs");
});
