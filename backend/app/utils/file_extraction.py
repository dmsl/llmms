import os
import tempfile
from PIL import Image
import pytesseract
import fitz  # PyMuPDF


def extract_text_from_pdf(pdf_path):
    text = ""
    with fitz.open(pdf_path) as pdf:
        for page_num in range(pdf.page_count):
            page = pdf[page_num]
            text += page.get_text("text")
    return text


def extract_text_from_image(file_path):
    try:
        image = Image.open(file_path)
        return pytesseract.image_to_string(image)
    except Exception as e:
        return f"Error extracting text from image: {str(e)}"


def handle_text_extraction(file):
    try:
        filename = file.filename.lower()
        with tempfile.NamedTemporaryFile(delete=False, suffix=filename) as temp_file:
            file.save(temp_file.name)
            temp_file_path = temp_file.name

        if filename.endswith(".pdf"):
            text = extract_text_from_pdf(temp_file_path)
        elif filename.endswith(".txt"):
            # Read the content from the saved text file
            with open(temp_file_path, "r", encoding="utf-8") as txt_file:
                text = txt_file.read()
        elif any(
            filename.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".tiff", ".bmp"]
        ):
            text = extract_text_from_image(temp_file_path)
        else:
            text = "Unsupported file format. Please upload PDF, TXT, or image."

        os.unlink(temp_file_path)
        return text

    except Exception as e:
        return f"Error processing file: {str(e)}"
