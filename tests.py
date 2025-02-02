import requests
from bs4 import BeautifulSoup
from readability.readability import Document

def get_max_context_tokens(model):
    """
    Mock function to simulate token limit retrieval for a model.
    """
    return 2048  # Assume a default max token limit

def web_search(query, model="default_model", current_token_count=0):
    """
    Perform a web search using SearxNG and return cleaned text content until it exceeds 0.8 of max tokens.
    """
    try:
        max_tokens = get_max_context_tokens(model)

        if not query:
            raise ValueError("Query is required")

        # SearxNG API URL
        SEARXNG_API_URL = "http://localhost:8080/search"

        # Parameters for the SearxNG API
        params = {
            "q": query,
            "format": "json",
            "categories": "general"
        }

        # Perform the GET request to SearxNG
        response = requests.get(SEARXNG_API_URL, params=params)
        if response.status_code != 200:
            raise Exception(f"SearxNG API error: {response.status_code} {response.text}")

        search_results = response.json()
        results = search_results.get("results", [])

        cleaned_content = ""
        urls = []

        # Iterate over results and fetch content
        for result in results:
            url = result.get("url")
            if not url:
                continue

            urls.append(url)

            try:
                # Fetch the URL content
                page_response = requests.get(url, timeout=10)
                page_response.raise_for_status()

                # Extract and clean text using BeautifulSoup and Readability
                soup = BeautifulSoup(page_response.text, "html.parser")
                doc = Document(page_response.text)
                cleaned_text = BeautifulSoup(doc.summary(), "html.parser").get_text(strip=True)

                if not cleaned_text.strip():
                    continue  # Skip if no meaningful content is extracted

                # Accumulate cleaned text
                cleaned_content += f"Source: {url}\n\n{cleaned_text}\n\n"
                token_count = len(cleaned_content.split()) + current_token_count

                # Stop if content exceeds 0.8 of max tokens
                if token_count >= max_tokens * 0.8:
                    break
            except requests.exceptions.RequestException as e:
                print(f"Error fetching URL {url}: {e}")
            except Exception as e:
                print(f"Error processing content from {url}: {e}")

        if not cleaned_content:
            print("No content could be extracted from the search results")
            return None

        return cleaned_content

    except Exception as e:
        print(f"Unexpected error in web_search: {e}")
        return None

# Test the function
if __name__ == "__main__":
    query = "music"
    result = web_search(query)
    if result:
        print("Cleaned Content:")
        print(result)
    else:
        print("No content returned.")
