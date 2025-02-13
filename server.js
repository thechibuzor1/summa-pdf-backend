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
const { OpenAI } = require("openai");

const pdfjsLib = require("pdfjs-dist");


const app = express();
const port = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const cache = new Map();

function cleanText(text) {
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
    return data.text.trim();
  } catch (error) {
    console.error("Error extracting text from PDF:", error);
    return null;
  }
}

async function extractTextFromImages(imageBuffer) {
  try {
    const processedImageBuffer = await sharp(imageBuffer)
      .resize({ width: 1000 })
      .grayscale()
      .normalize()
      .toFormat("png")
      .toBuffer();

    const tempImagePath = `./temp_images/ocr_${Date.now()}.png`;
    fs.writeFileSync(tempImagePath, processedImageBuffer);

    const { data } = await Tesseract.recognize(tempImagePath, "eng");
    fs.unlinkSync(tempImagePath);

    return data.text;
  } catch (error) {
    console.error("Error in OCR:", error);
    return null;
  }
}

async function extractTextDOCX(buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim();
  } catch (error) {
    console.error("Error extracting text from DOCX:", error);
    return null;
  }
}

async function extractTextFromOtherDocs(filePath) {
  return new Promise((resolve, reject) => {
    textract.fromFileWithPath(filePath, (error, text) => {
      if (error) {
        console.error("Error extracting text:", error);
        reject(null);
      } else {
        resolve(text.trim());
      }
    });
  });
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      temperature: 0,
      messages: [
        { 
          role: "user", 
          content: `
            You are an expert educator. Your task is to generate a **detailed study guide, an extensive quiz set, and a large collection of flashcards** based on the provided document. 
            **Prioritize high-quality quizzes and flashcards** while ensuring a structured summary.
    
            ### **Prioritization:**
             **(HIGH PRIORITY)** Generate **LOTS of quiz questions** with various types (**MCQs, true/false, fill-in-the-blank, and short-answer**).  
             **(HIGH PRIORITY)** Create **MANY flashcards** to reinforce key concepts.  
             **(MEDIUM PRIORITY)** Provide a **concise summary with key takeaways** rather than long explanations.  
             **(LOW PRIORITY)** Include a structured study guide that briefly outlines main topics with **comparisons, misconceptions, and real-world applications**.  
    
            ### **Expected JSON Response Format:**
            \`\`\`json
            {
              "summary": {
                "key_points": ["Key point 1", "Key point 2", "Key point 3"]
              },
              "flashcards": [
                {
                  "term": "Key Concept",
                  "definition": "Short and clear explanation"
                }
              ],
              "quiz": {
                "questions": [
                  {
                    "question": "What is XYZ?",
                    "type": "multiple_choice",
                    "options": ["Option A", "Option B", "Option C", "Option D"],
                    "answer": "Option B",
                    "explanation": "Reason why Option B is correct."
                  },
                  {
                    "question": "True or False: XYZ is related to ABC.",
                    "type": "true_false",
                    "answer": "True",
                    "explanation": "Explanation of the correct answer."
                  },
                  {
                    "question": "Fill in the blank: XYZ is an example of ____.",
                    "type": "fill_in_the_blank",
                    "answer": "Correct term",
                    "explanation": "Clarification of the answer."
                  }
                ]
              },
              "study_guide": {
                "sections": [
                  {
                    "title": "Main Topic",
                    "summary": "Short explanation with key takeaways.",
                    "comparisons": [
                      { "concept_a": "Concept A", "concept_b": "Concept B", "difference": "How they differ" }
                    ],
                    "real_world_applications": ["Example 1", "Example 2"],
                    "common_misconceptions": [
                      { "misunderstanding": "Misconception", "clarification": "Correct explanation" }
                    ]
                  }
                ]
              }
            }
            \`\`\`
    
            **Ensure the JSON output contains a large number of quiz questions and flashcards!**  
            The summary should be clear but concise.  
            The study guide should be structured but not overly detailed.  
    
            ### **Document Content:**
            ${cleanedText.substring(0, 30000)}
          `
        }
      ],
      response_format: { type: "json_object" } 
    });
    
    
    const summary = completion.choices[0].message.content;
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
