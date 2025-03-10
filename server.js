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
    const processedImageBuffer = await sharp(imageBuffer)
      .resize({ width: 1024 })
      .grayscale()
      .normalize()
      .toFormat("png")
      .toBuffer();

    const tempImagePath = `./temp_images/ocr_${Date.now()}.png`;
    fs.writeFileSync(tempImagePath, processedImageBuffer);

    const { data } = await Tesseract.recognize(tempImagePath, "eng");
    fs.unlinkSync(tempImagePath);

    return data.text ? data.text.trim() : "";
  } catch (error) {
    console.error("Error in OCR:", error);
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

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  if (!fs.existsSync("./temp_images")) fs.mkdirSync("./temp_images");
  if (!fs.existsSync("./temp_docs")) fs.mkdirSync("./temp_docs");
});
