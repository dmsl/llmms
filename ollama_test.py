import ollama


models = ollama.list().get("models", [])

# format the names
for model in models:
    model["name"] = model["name"].split(":")[0]
    model["name"] = model["name"].replace("-", " ")
    # capitalise first letter of each word
    model["name"] = model["name"].title()

    print(model["name"])
