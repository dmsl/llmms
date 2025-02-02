from flask import (
    Flask,
    request,
    jsonify,
    send_from_directory,
    Response,
    render_template,
)
import secrets


import fitz  # PyMuPDF
import requests
import os
from logging.handlers import RotatingFileHandler
from bs4 import BeautifulSoup
from readability.readability import Document
from PIL import Image  # For image processing
import pytesseract  # For OCR (Optical Character Recognition)
import logging
import json
import tempfile
import ollama

import chromadb


from flask_talisman import Talisman
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_cors import CORS
from flask_sslify import SSLify


# Initialize logging with rotation
logging.basicConfig(
    level=logging.DEBUG,  # Change to INFO or WARNING for production
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        RotatingFileHandler(
            "/home/konstantinkrasovitskiy/flask_app/app.log",
            maxBytes=5 * 1024 * 1024,  # 5 MB file size
            backupCount=3,  # Keep 3 backup files
        )
    ],
)

MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # Limit request size to 16 MB
UPLOAD_FOLDER = "/tmp/uploads"  # Temporary upload folder
ALLOWED_EXTENSIONS = {"pdf", "txt", "png", "jpg", "jpeg"}


# Generate a random 32-character key
# Initialize Flask App
app = Flask(__name__, template_folder="templates", static_folder="static")

# Generate a random 32-character secret key
app.config["SECRET_KEY"] = secrets.token_hex(32)

# Enforce HTTPS
# sslify = SSLify(app)

# Enable CSRF protection


# Enable CORS for specific origins
CORS(app, resources={r"/api/*": {"origins": "*"}})


# Rate Limiting
limiter = Limiter(
    get_remote_address, app=app, default_limits=["500 per day", "50 per hour"]
)


talisman = Talisman(
    app,
    content_security_policy={
        "default-src": [
            "'self'",
            "https://kit.fontawesome.com",
            "https://ka-f.fontawesome.com",
        ],
        "script-src": [
            "'self'",
            "https://cdnjs.cloudflare.com",
            "https://unpkg.com",
            "https://cdn.jsdelivr.net",
            "'unsafe-inline'",  # Enable inline scripts
            "https://kit.fontawesome.com",
            "https://ka-f.fontawesome.com",
        ],
        "style-src": [
            "'self'",
            "https://cdnjs.cloudflare.com",
            "https://cdn.jsdelivr.net",
            "'unsafe-inline'",
            "https://kit.fontawesome.com",
            "https://ka-f.fontawesome.com",
        ],
        "img-src": [
            "'self'",
            "data:",  # Allow data URIs for images
        ],
        "font-src": [
            "'self'",
            "https://cdnjs.cloudflare.com",
            "https://cdn.jsdelivr.net",
            "https://kit.fontawesome.com",
            "https://ka-f.fontawesome.com",
        ],
    },
)


file_handler = logging.FileHandler(
    "/home/konstantinkrasovitskiy/flask_app/flask_debug.log"
)


file_handler.setLevel(
    logging.DEBUG
)  # Or INFO if you want to log only informational and error logs
formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
file_handler.setFormatter(formatter)

app.logger.addHandler(file_handler)

# Set the default Flask logger to DEBUG level to capture all logs
app.logger.setLevel(logging.DEBUG)


chroma_client = chromadb.HttpClient(host="localhost", port=8000)
document_collection = chroma_client.get_or_create_collection(name="my_collection")


MAX_CONTEXT_TOKENS = 2048
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# Serve the static HTML page for the UI
# Flask Routes
@app.route("/")
def index():
    """
    Serve the index page with dynamically loaded CSS files.
    """
    csrf_token = "ABCDEF"
    css_dir = os.path.join(app.static_folder, "css")
    css_files = [
        f"css/{file}"
        for file in os.listdir(css_dir)
        if file.endswith(".css") and file != "style.css"
    ]

    js_dir = os.path.join(app.static_folder, "js")
    js_files = [
        f"js/{file}"
        for file in os.listdir(js_dir)
        if file.endswith(".js") and "script.js" not in file and "esm" not in file
        # Exclude files that are boostrap.min
        and "min" in file
    ]

    app.logger.info(f"js_files: {js_files}")
    return render_template(
        "index.html", csrf_token=csrf_token, css_files=css_files, js_files=js_files
    )


@app.route("/chat")
def chat():
    csrf_token = "ABCDEF"
    css_dir = os.path.join(app.static_folder, "css")
    css_files = [
        f"css/{file}"
        for file in os.listdir(css_dir)
        if file.endswith(".css")
        and "min" in file
        or "chat.css" in file
        and not "freelancer" in file
        and not "sport" in file
        and not "bootstrap" in file
    ]

    js_dir = os.path.join(app.static_folder, "js")
    js_files = [
        f"js/{file}"
        for file in os.listdir(js_dir)
        if file.endswith(".js")
        and "esm" not in file
        and "min" in file
        or "script.js" in file
        and not "bootstrap" in file
    ]

    return render_template(
        "chat.html", csrf_token=csrf_token, css_files=css_files, js_files=js_files
    )


@app.route("/terms")
def terms():
    return render_template(
        "terms.html",
    )


@app.route("/privacy")
def privacy():
    return render_template("privacy.html")


def save_to_chromadb(name, content, embedding=None):

    try:
        # Add the document to the ChromaDB collection
        document_collection.add(
            documents=[content],
            metadatas=[{"name": name}],
            embeddings=[embedding] if embedding else None,
        )
        app.logger.info(f"Document '{name}' saved to ChromaDB.")
        return {"success": True, "message": "Document saved successfully to ChromaDB."}
    except Exception as e:
        error_message = f"ChromaDB error: {str(e)}"
        app.logger.error(error_message)
        return {"success": False, "error": error_message}


def extract_text_from_pdf(pdf_path):

    text = ""
    with fitz.open(pdf_path) as pdf:
        for page_num in range(pdf.page_count):
            page = pdf[page_num]
            text += page.get_text("text")

    return text


# return send_from_directory("static", "index.html")


def get_context_length(model_details):

    # Step 1: Directly attempt to retrieve from known location for llama models
    context_length = model_details.get("model_info", {}).get("llama.context_length")
    if context_length:
        return context_length
    context_length = model_details.get("model_info", {}).get("gemma2.context_length")
    if context_length:
        return context_length
    context_length = model_details.get("model_info", {}).get(
        "nomic-bert.context_length"
    )
    if context_length:
        return context_length

    # Step 2: Use family-based key access if 'family' is specified in details
    family_name = model_details.get("details", {}).get("family")
    if family_name:
        # Attempt to access using family name key structure, e.g., `nomic-bert.context_length` or `gemma2.context_length`
        context_length = model_details.get("model_info", {}).get(
            f"{family_name}.context_length"
        )
        if context_length:
            return context_length

        context_length = model_details.get(f"{family_name}.context_length")
        if context_length:
            return context_length

    # Default value if no context length is found
    return 2048


@app.route("/get_models", methods=["GET"])
def get_models():

    try:
        # Step 1: List all available models
        models = ollama.list().get("models", [])

        # Step 2: Retrieve context length for each model
        formatted_models = []
        for model in models:
            model_name = model.get("name")
            if "embed" in model_name:
                continue
            if "9b" in model_name:
                continue
            if model_name:
                try:
                    # Fetch detailed information about the model
                    model_details = ollama.show(model_name)

                    # Get the context length using the family-based retrieval function
                    context_length = get_context_length(model_details)

                    # Add model with context length to the formatted list
                    # process the model name to be readable
                    model_id = model_name
                    model_name = model_name.split(":")[0]
                    model_name = model_name.replace("-", " ")
                    model_name = model_name.title()
                    formatted_models.append(
                        {
                            "id": model_id,
                            "name": model_name,
                            "context_length": context_length,
                        }
                    )
                except Exception as e:
                    app.logger.error(
                        f"Error fetching details for model {model_name}: {e}"
                    )
                    # Add the model with default context limit if an error occurs
                    formatted_models.append(
                        {"id": model_name, "name": model_name, "context_length": -1}
                    )

        return jsonify({"models": formatted_models}), 200

    except Exception as e:
        app.logger.error(f"Error fetching models: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/send_message", methods=["POST"])
def send_message():
    data = request.get_json()
    model = data.get("model")
    message_history = data.get("messages", [])
    # log the message history
    app.logger.info(f"Message history: {message_history}")
    app.logger.info(f"Model: {model}")
    user_message = data.get("messages")[-1].get("content")

    # if websearch is true execute websearch
    websearch = data.get("websearch")
    webresults = ""
    if websearch is True:
        webresults += (
            "The following data is not part of the users question , it is helpful data generated from a web search you made . Always tell the sources . Here are the most relevant from the web : "
            + web_search(user_message, model, len(message_history))
            + "\n"
        )
    # Add the user's new message to the message history
    # edit the last message to include the websearch
    if webresults:
        message_history[-1]["content"] += webresults

    # Generator function to stream each chunk of the response
    def generate_response():
        stream = ollama.chat(
            model=model,
            messages=message_history,
            stream=True,
        )

        for chunk in stream:
            content = chunk.get("message", {}).get("content", "")
            if content:
                yield f"{content}"  # Send chunk to client as Server-Sent Events (SSE)

    # Return the Response with streamed content
    return Response(generate_response(), content_type="text/event-stream")


# Default embedding model
EMBED_MODEL = "nomic-embed-text"


def get_ollama_embedding(text):

    try:

        response = ollama.embeddings(model=EMBED_MODEL, prompt=text)

        # Extract and return the embedding
        if response and "embedding" in response:

            return response["embedding"]
        else:
            app.logger.error("Embedding data not found in the response.")
            raise Exception("Embedding data not found in the response.")

    except Exception as e:
        raise Exception(f"Failed to get embedding using Ollama library: {str(e)}")


def retrieve_relevant_text(query, top_k=3):

    try:
        query_embedding = get_ollama_embedding(query)
        results = document_collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,  # Retrieve more than one relevant result
        )
        relevant_contexts = [
            doc for docs in results.get("documents", []) for doc in docs
        ]
        # Combine the top-k relevant contexts into a single string
        return "\n---\n".join(relevant_contexts)
    except Exception as e:
        app.logger.error(f"Error in ChromaDB query: {e}", exc_info=True)
        return "Error retrieving relevant text."


def ollama_generate_completion(model, messages):

    url = "http://localhost:11434/api/completions"
    payload = {"model": model, "messages": messages}
    response = requests.post(url, json=payload)

    if response.status_code == 200:
        return response.json().get("choices", [{}])[0].get("message", {}).get("content")
    else:
        raise Exception(
            f"Failed to generate response from Ollama: {response.status_code} {response.text}"
        )


def get_max_context_tokens(model_name):

    try:
        # Retrieve model details
        model_info = ollama.show(model_name)
        # Extract the context length
        max_context_tokens = model_info.get("context_length")
        if max_context_tokens is not None:
            return max_context_tokens
        else:
            raise ValueError(
                "Context length information is not available for this model."
            )
    except Exception as e:
        print(f"An error occurred: {e}")
        return None


def get_token_count(text):

    # Simplistic tokenization based on words; you might replace with a more accurate tokenizer
    return len(text.split())


def summarize_text(text, model="mistral-small"):

    summary = ""
    try:
        # Use the Ollama API to generate a summary in a single, non-streaming response
        response = ollama.chat(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": "Summarize the following conversation in points. If not everything can be summarized, keep the most important information only on big text. Keep details that may be asked later . Make sure you keep track of all subjects:",
                },
                {"role": "user", "content": text},
            ],
        )

        # Assuming `response` is now a complete response without streaming, directly access its content
        if response and "message" in response:
            summary = response["message"]["content"]

    except Exception as e:
        print(f"Summarization failed: {str(e)}")

    return summary


def manage_message_history(message_history, max_context_tokens, model):

    # Calculate the total token count in the message history
    total_tokens = sum(get_token_count(msg["content"]) for msg in message_history)

    # If within the token limit, no need to modify
    if total_tokens <= max_context_tokens:
        return message_history

    # Concatenate older messages to summarize
    text_to_summarize = ""
    while total_tokens > 0 and len(message_history) > 1:
        # Keep appending the oldest messages to summarize until we reach the desired length
        text_to_summarize += message_history.pop(0)["content"] + " "
        total_tokens = sum(get_token_count(msg["content"]) for msg in message_history)

    # Summarize the collected text
    summary = summarize_text(text_to_summarize.strip())

    return {"role": "system", "content": f"Conversation summary: {summary}"}


@app.route("/manage_history", methods=["POST"])
def manage_history():

    data = request.get_json()
    model = data.get("model")
    if not model:
        return jsonify({"error": "Model name not provided"}), 400
    max_context_tokens = data.get("max_tokens")
    message_history = data.get("messages", [])

    if not max_context_tokens:
        return jsonify({"error": "Could not retrieve model context length"}), 501

    # Manage history to fit within context window
    updated_history = manage_message_history(message_history, max_context_tokens, model)

    # Return the updated history
    return jsonify({"messages": updated_history})


@app.route("/rag_chain", methods=["POST"])
def rag_chain():

    try:
        # Step 1: Check for uploaded file
        file = request.files.get("file")
        if not file or file.filename == "":
            app.logger.error("Step 1: Uploaded file is missing or empty.")
            return jsonify({"error": "No file or empty file uploaded"}), 400

        app.logger.info(f"Step 1: File '{file.filename}' successfully uploaded.")

        # Step 2: Extract text from the uploaded file
        extracted_text = handle_text_extraction(file)
        if extracted_text.startswith("Error"):
            app.logger.error(f"Step 2: Error extracting text: {extracted_text}")
            return jsonify({"error": extracted_text}), 500

        app.logger.info(
            f"Step 2: Successfully extracted text from file '{file.filename}'."
        )

        # Step 3: Check if text fits within model's context length
        model = request.form.get("model")
        if not model:
            return jsonify({"error": "Model name is required"}), 400

        max_context_tokens = get_max_context_tokens(model)
        if max_context_tokens is None:
            max_context_tokens = (
                2048  # Default to 2048 tokens if context length is not available
            )
        context = ""
        total_tokens = get_token_count(extracted_text)
        if total_tokens <= max_context_tokens * 0.7:
            # If the document fits, use the full text
            app.logger.info(
                "The document fits within the model's context length; using full text."
            )
            context += f"Context:\n{extracted_text}\n"
        else:
            # Retrieve relevant sections

            # get last message from the messages and get the content field from it

            query = request.form.get("messages")
            # add the context to the last message

            # query = query[-1].get("content")
            if not query:
                app.logger.error("Query is missing for large file.")
                return jsonify({"error": "Query is required for large files"}), 400

            save_result = save_to_chromadb(
                file.filename, extracted_text, get_ollama_embedding(extracted_text)
            )
            if not save_result.get("success"):
                app.logger.error(
                    f"Error saving to ChromaDB: {save_result.get('error')}"
                )
            retrieved_texts = retrieve_relevant_text(
                query, top_k=3
            )  # Retrieve more than one relevant section
            context += f"Context:\n{retrieved_texts}\n"
        # if websearch is true execute websearch
        # delete collection after use

        chroma_client.delete_collection(name="my_collection")

        # Add the context to the message history
        messages = json.loads(request.form.get("messages"))
        messages.append({"role": "system", "content": context})

        websearch = request.form.get("websearch")
        messages = request.form.get("messages")

        app.logger.info(f"Created context: {context}")

        # Step 4: Append the context to the message history

        if messages is None:
            return jsonify({"error": "Messages are required"}), 400

        messages = json.loads(messages)
        # edit the last message to include the websearch and context
        if websearch is True:
            # add the websearch to the last message context
            messages.append(
                {
                    "role": "system",
                    "content": "Context:" + web_search(query, model, len(messages)),
                }
            )

        data = {"model": model, "messages": messages}

        # Generate response using Ollama
        def generate_response():
            stream = ollama.chat(
                model=model,
                messages=data["messages"],
                stream=True,
            )
            for chunk in stream:
                content = chunk.get("message", {}).get("content", "")
                if content:
                    yield f"{content}"  # Send chunk to client as Server-Sent Events (SSE)

        return Response(generate_response(), content_type="text/event-stream")

    except Exception as e:
        app.logger.error(f"Unexpected error in rag_chain: {e}", exc_info=True)
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500


@app.route("/update_session", methods=["POST"])
def update_session():

    data = request.get_json()
    model = data.get("model")
    if not model:
        return jsonify({"error": "Model name not provided"}), 400
    max_context_tokens = data.get("max_tokens")
    message_history = data.get("messages", [])

    if not max_context_tokens:
        return jsonify({"error": "Could not retrieve model context length"}), 501

    """
    Trim or summarize the message history to fit within the model's context window.
    """
    # Calculate the total token count in the message history
    total_tokens = sum(get_token_count(msg["content"]) for msg in message_history)

    # If within the token limit, no need to modify
    if total_tokens <= max_context_tokens:
        return message_history

    # Concatenate older messages to summarize
    text_to_summarize = ""
    while total_tokens > 0 and len(message_history) > 1:
        # Keep appending the oldest messages to summarize until we reach the desired length
        text_to_summarize += message_history.pop(0)["content"] + " "
        total_tokens = sum(get_token_count(msg["content"]) for msg in message_history)

    model = request.form.get("model", "mistral-small")  # Get model from form

    summary = ""
    try:
        # Use the Ollama API to generate a summary in a single, non-streaming response
        response = ollama.chat(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": "Summarize the following conversation in maximum 5 words only . The most important info is the first messages",
                },
                {"role": "user", "content": text_to_summarize.strip()},
            ],
        )

        # Assuming `response` is now a complete response without streaming, directly access its content
        if response and "message" in response:
            summary = response["message"]["content"]
        trials = 0
        while len(summary.split()) > 6 and trials < 3:
            trials += 1
            response = ollama.chat(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": f"Summarize the following conversation in maximum 5 words only . The most important info is the first messages, the previous summary ({summary}) was too long",
                    },
                    {"role": "user", "content": text_to_summarize.strip()},
                ],
            )
            if response and "message" in response:
                summary = response["message"]["content"]

    except Exception as e:
        print(f"Summarization failed: {str(e)}")

    return summary


@app.route("/create_model", methods=["POST"])
def create_model():

    try:
        # Parse request data
        data = request.form.to_dict()
        base_model = data.get("from")
        model_name = data.get("name")
        num_ctx = data.get("num_ctx")
        template = data.get("template")
        system_message = data.get("system")
        adapter = data.get("adapter")
        license_text = data.get("license")
        parameters = data.get("parameters", {})
        messages = data.get("messages", [])

        # Handle file upload
        file = request.files.get("file")
        behavioral_text = handle_text_extraction(file) if file else ""

        # Combine system_message with behavioral laws if present
        if behavioral_text and not behavioral_text.startswith("Error"):
            system_message = (
                f"{system_message}\n\nBehavioral Laws:\n{behavioral_text}"
                if system_message
                else f"Behavioral Laws:\n{behavioral_text}"
            )

        # Build Modelfile content dynamically
        modelfile_content = f"""FROM {base_model}\n"""

        if num_ctx:
            modelfile_content += f"PARAMETER num_ctx {num_ctx}\n"
        if system_message:
            modelfile_content += f'SYSTEM """\n{system_message}\n"""\n'
        if template:
            modelfile_content += f'TEMPLATE """\n{template}\n"""\n'
        if adapter:
            modelfile_content += f'ADAPTER "{adapter}"\n'
        if license_text:
            modelfile_content += f'LICENSE """\n{license_text}\n"""\n'

        for param, value in parameters.items():
            modelfile_content += f"PARAMETER {param} {value}\n"

        for message in messages:
            role = message.get("role", "user")
            content = message.get("content", "")
            modelfile_content += f'MESSAGE {role} "{content}"\n'

        # Use a temporary file for the Modelfile
        with tempfile.NamedTemporaryFile(
            mode="w", delete=False, suffix=".modelfile"
        ) as temp_modelfile:
            temp_modelfile.write(modelfile_content)
            temp_modelfile_path = temp_modelfile.name

        # Create the model using Ollama
        try:
            ollama.create(model_name, temp_modelfile_path)
        except Exception as e:
            return jsonify({"error": f"Failed to create model: {str(e)}"}), 500

        # Cleanup
        os.unlink(temp_modelfile_path)

        return jsonify({"message": f"Model {model_name} created successfully"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


def extract_text_from_image(file_path):

    try:
        image = Image.open(file_path)
        return pytesseract.image_to_string(image)
    except Exception as e:
        return f"Error extracting text from image: {str(e)}"


def handle_text_extraction(file):

    try:
        if file.filename.endswith(".pdf"):
            # Extract text from PDF
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_pdf:
                file.save(temp_pdf.name)
                text = extract_text_from_pdf(temp_pdf.name)
                os.unlink(temp_pdf.name)
                return text
        elif file.filename.endswith(".txt"):
            # Read plain text file
            return file.read().decode("utf-8")
        elif file.filename.lower().endswith((".png", ".jpg", ".jpeg", ".tiff", ".bmp")):
            # Extract text from image
            with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_img:
                file.save(temp_img.name)
                text = extract_text_from_image(temp_img.name)
                os.unlink(temp_img.name)
                return text
        else:
            return "Unsupported file format. Please upload PDF, TXT, or image."
    except Exception as e:
        return f"Error processing file: {str(e)}"


def web_search(user_msg, model, current_token_count=0):

    try:
        # Use dummy query for testing
        query = user_msg
        # Fetch detailed information about the model
        model_details = ollama.show(model)

        max_tokens = get_context_length(model_details)

        if not query:
            return "Query is required"

        # SearxNG API URL
        SEARXNG_API_URL = "http://localhost:8080/search"

        # Parameters for the SearxNG API
        params = {"q": query, "format": "json", "categories": "general"}

        # Perform the GET request to SearxNG
        response = requests.get(SEARXNG_API_URL, params=params)
        if response.status_code != 200:
            app.logger.error(
                f"SearxNG API error: {response.status_code} {response.text}"
            )
            return "Failed to fetch search results"

        search_results = response.json()
        results = search_results.get("results", [])

        cleaned_content = ""

        # Iterate over results and fetch content
        for result in results:
            url = result.get("url")
            if not url:
                continue

            try:
                # Fetch the URL content
                page_response = requests.get(
                    url, timeout=10
                )  # Set timeout for faster error handling
                page_response.raise_for_status()

                # Extract and clean text using BeautifulSoup and Readability
                soup = BeautifulSoup(page_response.text, "html.parser")
                doc = Document(page_response.text)
                cleaned_text = BeautifulSoup(doc.summary(), "html.parser").get_text(
                    strip=True
                )

                if not cleaned_text.strip():
                    continue  # Skip if no meaningful content is extracted

                # Accumulate cleaned text
                cleaned_content += f"Source: {url}\n\n{cleaned_text}\n\n"
                token_count = len(cleaned_content.split()) + current_token_count

                # Stop if content exceeds 0.8 of max tokens
                if token_count >= max_tokens * 0.7:
                    break
            except requests.exceptions.RequestException as e:
                app.logger.error(f"Error fetching URL {url}: {e}")
            except Exception as e:
                app.logger.error(f"Error processing content from {url}: {e}")

        if not cleaned_content:
            return "No content could be extracted from the search results"

        return cleaned_content

    except Exception as e:
        app.logger.error(f"Unexpected error in web_search: {e}")
        return "Internal server error occurred"


logging.basicConfig(
    filename="email_log.txt", level=logging.INFO, format="%(asctime)s - %(message)s"
)


@app.route("/submit-form", methods=["POST"])
def submit_form():
    data = request.get_json()

    name = data.get("name")
    email = data.get("email")
    message = data.get("message")

    if not name or not email or not message:
        return jsonify({"error": "Invalid input"}), 400

    # Log the email to the server log file
    logging.info(f"Email received: {email}")

    # Add further processing logic here if needed (e.g., save to database)

    return jsonify({"success": "Form submitted successfully"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
