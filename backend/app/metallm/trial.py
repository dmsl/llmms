import sys
import os
import unicodedata

def read_file_with_nonprintable(filename):
    """Read file byte by byte and display non-printable characters"""
    
    # Check if file exists
    if not os.path.exists(filename):
        print(f"Error: File '{filename}' not found")
        return
    
    try:
        # First try to read as UTF-8 to detect Unicode hidden characters
        print(f"Reading file: {filename}")
        print("=" * 70)
        
        # Read as bytes first
        with open(filename, 'rb') as file:
            raw_data = file.read()
        
        print(f"File size: {len(raw_data)} bytes")
        print("=" * 70)
        
        # Try to decode as UTF-8
        try:
            text_content = raw_data.decode('utf-8')
            print("UTF-8 Analysis:")
            print("-" * 30)
            analyze_unicode_text(text_content)
            print()
        except UnicodeDecodeError:
            print("File is not valid UTF-8, analyzing as raw bytes only")
        
        # Always do byte-by-byte analysis
        print("Byte-by-byte Analysis:")
        print("-" * 30)
        analyze_raw_bytes(raw_data)
            
    except IOError as e:
        print(f"Error reading file: {e}")

def analyze_unicode_text(text):
    """Analyze Unicode text for hidden/invisible characters"""
    line_count = 1
    char_count = 0
    hidden_chars_found = []
    
    print(f"Line {line_count:3d}: ", end="")
    
    for char in text:
        char_count += 1
        code_point = ord(char)
        
        # Standard characters - display normally
        if char == '\n':
            print("\\n")
            line_count += 1
            print(f"Line {line_count:3d}: ", end="")
        elif char == '\r':
            print("\\r", end="")
        elif char == '\t':
            print("\\t", end="")
        elif char == ' ':  # Regular space
            print(" ", end="")
        elif is_non_standard_char(char):
            # Non-standard/hidden characters
            char_name = unicodedata.name(char, f"U+{code_point:04X}")
            display = f"[{char_name}:U+{code_point:04X}]"
            print(display, end="")
            hidden_chars_found.append((char, code_point, char_name))
        elif char.isprintable():
            # Regular printable characters
            print(char, end="")
        else:
            # Other non-printable characters
            char_name = unicodedata.name(char, f"U+{code_point:04X}")
            print(f"[{char_name}:U+{code_point:04X}]", end="")
            hidden_chars_found.append((char, code_point, char_name))
    
    print()
    print("=" * 70)
    print(f"Total characters: {char_count}")
    
    if hidden_chars_found:
        print(f"Non-standard/Hidden characters found: {len(hidden_chars_found)}")
        for char, code_point, name in set(hidden_chars_found):
            count = hidden_chars_found.count((char, code_point, name))
            print(f"  U+{code_point:04X} ({name}) - {count} occurrence(s)")

def is_non_standard_char(char):
    """Check if character is non-standard (potentially hidden/watermark)"""
    code_point = ord(char)
    
    # Standard whitespace characters that are OK
    standard_whitespace = [0x0020, 0x0009, 0x000A, 0x000D]  # space, tab, LF, CR
    
    if code_point in standard_whitespace:
        return False
    
    # Zero Width characters (common in watermarks)
    zero_width_chars = [
        0x200B,  # Zero Width Space
        0x200C,  # Zero Width Non-Joiner
        0x200D,  # Zero Width Joiner
        0x2060,  # Word Joiner
        0xFEFF,  # Zero Width No-Break Space (BOM)
    ]
    
    # Non-standard whitespace and invisible characters
    non_standard_chars = [
        0x00A0,  # Non-Breaking Space
        0x00AD,  # Soft Hyphen
        0x034F,  # Combining Grapheme Joiner
        0x061C,  # Arabic Letter Mark
        0x115F,  # Hangul Choseong Filler
        0x1160,  # Hangul Jungseong Filler
        0x17B4,  # Khmer Vowel Inherent AQ
        0x17B5,  # Khmer Vowel Inherent AA
        0x180E,  # Mongolian Vowel Separator
        0x2000,  # En Quad
        0x2001,  # Em Quad
        0x2002,  # En Space
        0x2003,  # Em Space
        0x2004,  # Three-Per-Em Space
        0x2005,  # Four-Per-Em Space
        0x2006,  # Six-Per-Em Space
        0x2007,  # Figure Space
        0x2008,  # Punctuation Space
        0x2009,  # Thin Space
        0x200A,  # Hair Space
        0x202F,  # Narrow No-Break Space
        0x205F,  # Medium Mathematical Space
        0x3000,  # Ideographic Space
        0x3164,  # Hangul Filler
    ]
    
    if code_point in zero_width_chars + non_standard_chars:
        return True
    
    # Check Unicode categories for potentially hidden characters
    category = unicodedata.category(char)
    if category in ['Mn', 'Me', 'Cf']:  # Mark nonspacing, Mark enclosing, Other format
        return True
    
    # Check for unusual whitespace in general categories
    if category == 'Zs' and code_point != 0x0020:  # Space separator but not regular space
        return True
    
    return False

def analyze_raw_bytes(data):
    """Analyze raw byte data"""
    byte_count = 0
    line_count = 1
    
    print(f"Line {line_count:3d}: ", end="")
    
    for byte_value in data:
        byte_count += 1
        
        # Handle different character types
        if byte_value == 10:  # Line Feed (LF)
            print("\\n")
            line_count += 1
            print(f"Line {line_count:3d}: ", end="")
        elif byte_value == 13:  # Carriage Return (CR)
            print("\\r", end="")
        elif byte_value == 9:  # Tab
            print("\\t", end="")
        elif byte_value == 0:  # Null
            print("\\0", end="")
        elif 32 <= byte_value <= 126:  # Printable ASCII
            print(chr(byte_value), end="")
        else:  # Non-printable characters
            print(f"\\x{byte_value:02x}", end="")
    
    print()
    print("=" * 70)
    print(f"Total bytes: {byte_count}")

def main():
    # Get the directory where the script is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    filename = os.path.join(script_dir, "input.txt")
    
    # You can also accept filename as command line argument
    if len(sys.argv) > 1:
        filename = os.path.join(script_dir, sys.argv[1])
    
    read_file_with_nonprintable(filename)

if __name__ == "__main__":
    main()
