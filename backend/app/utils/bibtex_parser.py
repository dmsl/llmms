"""
SmartBIB: The SmartBIB Project allows you to present a BIB database
(.bibtex files) containing your publications on the web.
It is ideal for personal and project websites.

Original Copyright (C) 2012 Georgios Larkou - DMSL - University of Cyprus
Python adaptation Copyright (C) 2023

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.
"""

import re
from typing import Dict, List, Any, Optional, Set, Tuple

class BibTexParser:
    """Python implementation of the SmartBIB BibTeX parser."""
    
    def __init__(self, file_path: Optional[str] = None, data: Optional[str] = None):
        """
        Initialize the BibTeX parser
        
        Args:
            file_path: Path to BibTeX file
            data: String containing BibTeX data
        """
        self.count = -1
        self.items = {
            'note': [], 'abstract': [], 'year': [], 'group': [],
            'publisher': [], 'location': [], 'articleno': [], 'numpages': [],
            'doi': [], 'page-start': [], 'page-end': [], 'pages': [],
            'address': [], 'url': [], 'volume': [], 'chapter': [],
            'journal': [], 'author': [], 'raw': [], 'title': [],
            'booktitle': [], 'folder': [], 'type': [], 'series': [],
            'linebegin': [], 'lineend': [], 'durl': [], 'powerpoint': [],
            'infosite': [], 'website': [], 'projects': [], 'isbn': []
        }
        self.sorted_items = {}
        self.types = []
        self.filename = file_path
        self.inputdata = data
        self.year_data = []
        self.last_type = None
        self.resulted_html = ""
        
    def parse(self) -> None:
        """Parse the BibTeX data into structured items."""
        if self.filename:
            with open(self.filename, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        else:
            lines = self.inputdata.split('\n')
        
        if not lines:
            return
            
        value = []
        var = []
        self.count = -1
        lineindex = 0
        fieldcount = -1
        
        for line in lines:
            lineindex += 1
            # Only update lineend if count is valid and the list has been initialized
            if self.count > -1 and len(self.items['lineend']) > self.count:
                self.items['lineend'][self.count] = lineindex
                
            line = line.strip()
            raw_line = line + '\n'
            line = line.replace("'", "`")
            seg = line.replace('"', "`")
            ps = seg.find('=')
            segtest = seg.lower()
            
            # Skip various comment types
            if '@string' in segtest:
                continue
            if '@comment' in segtest:
                continue
            if '%%' in seg:
                continue
            if not seg:
                continue
                
            if seg.startswith("@"):
                self.count += 1
                self.items['raw'].append(line + "\r\n")
                
                # Initialize all lists to have at least count+1 elements
                for key in self.items:
                    while len(self.items[key]) <= self.count:
                        self.items[key].append('')
                
                ps = seg.find('@')
                pe = seg.find('{')
                if pe != -1:
                    entry_type = seg[1:pe].strip()
                    self.items['type'][self.count] = entry_type.lower()
                    self.types.append(entry_type.lower())
                
                fieldcount = -1
                self.items['linebegin'][self.count] = lineindex
            elif ps != -1:  # Field begins
                if self.count >= 0:  # Make sure we have a valid entry first
                    self.items['raw'][self.count] += line + "\r\n"
                    fieldcount += 1
                    if len(var) <= fieldcount:
                        var.append(seg[:ps].strip().lower())
                    else:
                        var[fieldcount] = seg[:ps].strip().lower()
                    
                    if var[fieldcount] == 'pages':
                        ps = seg.find('=')
                        pm = seg.find('--')
                        pe = seg.find('},')
                        if pm != -1 and pe != -1:
                            page_from = seg[ps:pm]
                            page_to = seg[pm:pe]
                            bp = page_from.replace('=', '').replace('{', '').replace('}', '').replace('-', '').strip()
                            ep = page_to.replace('=', '').replace('{', '').replace('}', '').replace('-', '').strip()
                    
                    pe = seg.find('},')
                    
                    if pe == -1:
                        if len(value) <= fieldcount:
                            value.append(seg[ps:] if ps != -1 else '')
                        else:
                            value[fieldcount] = seg[ps:] if ps != -1 else ''
                    else:
                        if len(value) <= fieldcount:
                            value.append(seg[ps:pe] if ps != -1 else '')
                        else:
                            value[fieldcount] = seg[ps:pe] if ps != -1 else ''
            else:
                if self.count > -1 and self.count < len(self.items['raw']):
                    self.items['raw'][self.count] += line + "\r\n"
                    pe = seg.find('},')
                
                if fieldcount > -1:
                    if pe == -1:
                        value[fieldcount] += ' ' + seg
                    else:
                        value[fieldcount] += ' ' + (seg[ps:pe] if ps != -1 else '')
            
            if fieldcount > -1 and len(value) > fieldcount:
                v = value[fieldcount]
                v = v.replace('=', '').replace('{', '').replace('}', '')
                
                if var[fieldcount] == 'projects':
                    v = v.replace(',', ' ')
                else:
                    v = self.str_last_replace(',', ' ', v)
                    
                v = v.replace('\'', ' ').replace('\"', ' ').replace('`', "'")
                v = v.strip()
                
                # Ensure the field exists in the items dictionary
                field_name = var[fieldcount]
                if field_name not in self.items:
                    self.items[field_name] = [''] * (self.count + 1)
                
                # Add empty entries if needed
                while len(self.items[field_name]) <= self.count:
                    self.items[field_name].append('')
                    
                # Add the value
                self.items[field_name][self.count] = v
        
        # Fill any missing fields with empty strings for consistency
        for key in self.items:
            while len(self.items[key]) < self.count + 1:
                self.items[key].append('')
    
    def sort_items(self) -> None:
        """Sort publications by type and year."""
        # Define the sort order for entry types
        sort_by = [
            'journal', 'conference', 'book', 'editorial', 'theses', 'gconferences'
        ]
        
        # Create a temporary dictionary with each entry as its own dict
        temp_items = []
        for i in range(len(self.items['type'])):
            entry = {}
            for key, values in self.items.items():
                if i < len(values):
                    entry[key] = values[i]
                else:
                    entry[key] = ''
            temp_items.append(entry)
        
        # Sort by type (according to sort_by order) then by year in descending order
        def get_type_order(item):
            if 'type' in item and item['type'] in sort_by:
                return sort_by.index(item['type'])
            return len(sort_by)
            
        # Sort first by type, then by descending year
        temp_items.sort(key=lambda x: (get_type_order(x), -int(x['year']) if x.get('year', '').isdigit() else 0))
        
        # Convert back to original format
        self.sorted_items = {key: [] for key in self.items.keys()}
        for item in temp_items:
            for key, value in item.items():
                self.sorted_items.setdefault(key, []).append(value)
                
        # Update types list to match the sorted order
        self.types = self.sorted_items['type']
    
    def get_title(self, type_name: str) -> str:
        """Get a display title for each publication type."""
        # Use the global sortby and sortbyTitle arrays as defined in the PHP version
        sort_by = ['journal', 'conference', 'book', 'editorial', 'theses', 'gconferences']
        sort_by_title = ['Journal and Magazine Papers', 'Conference and Workshop Papers', 'Book Chapters', 'Editorials', 'Theses', 'Greek Conferences']
        
        for i in range(len(sort_by)):
            if sort_by[i] == type_name:
                return sort_by_title[i]
        
        return 'Other Publications'
    
    def check_project(self, element: int, project_filter: List[str]) -> bool:
        """Check if the publication belongs to the specified project(s)."""
        if 'all' in project_filter:
            return True
            
        if element < len(self.sorted_items.get('projects', [])) and self.sorted_items['projects'][element]:
            projects = self.sorted_items['projects'][element].split()
            for project in projects:
                if project in project_filter:
                    return True
        
        return False
    
    def prepare_html(self, projects: List[str] = ['all']) -> None:
        """Prepare HTML for displaying the publications."""
        # Define the field formats for different types of publications
        article = ["title", "author", "journal", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        book = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        booklet = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        conference = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year", "award"]
        inbook = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        incollection = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "chapter", "pages", "address", "isbn", "year", "award"]
        inproceedings = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "chapter", "pages", "address", "isbn", "year", "award"]
        manual = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        mastersthesis = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        misc = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        phdthesis = ["title", "author", "journal", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        proceedings = ["booktitle", "series", "author", "location", "publisher", "volume", "pages", "address", "isbn", "year", "award"]
        techreport = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        unpublished = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        other = ["title", "author", "booktitle", "series", "location", "publisher", "volume", "pages", "address", "isbn", "year"]
        
        self.resulted_html = '<ul id="publication-list">'
        
        for i in range(self.count + 1):
            if 'all' in projects or self.check_project(i, projects):
                pub_type = self.types[i].lower() if i < len(self.types) else ''
                
                if pub_type == "journal" or pub_type == "article":
                    self.html_publication("journal", article, i)
                elif pub_type == "book":
                    self.html_publication("book", book, i)
                elif pub_type == "booklet":
                    self.html_publication("booklet", booklet, i)
                elif pub_type == "conference":
                    self.html_publication("conference", conference, i)
                elif pub_type == "inbook":
                    self.html_publication("inbook", inbook, i)
                elif pub_type == "incollection":
                    self.html_publication("incollection", incollection, i)
                elif pub_type == "inproceedings":
                    self.html_publication("inproceedings", inproceedings, i)
                elif pub_type == "manual":
                    self.html_publication("manual", manual, i)
                elif pub_type == "mastersthesis":
                    self.html_publication("mastersthesis", mastersthesis, i)
                elif pub_type == "misc":
                    self.html_publication("misc", misc, i)
                elif pub_type == "phdthesis":
                    self.html_publication("phdthesis", phdthesis, i)
                elif pub_type == "proceedings":
                    self.html_publication("proceedings", proceedings, i)
                elif pub_type == "techreport":
                    self.html_publication("techreport", techreport, i)
                elif pub_type == "unpublished":
                    self.html_publication("unpublished", unpublished, i)
                else:
                    self.html_publication("other", other, i)
        
        self.resulted_html += '</ul>'
        bib_tex_file = self.filename or "publications.bib"
        self.resulted_html += f'<center><small>Automatically generated from this <a href="{bib_tex_file}" target="_blank" >bibtex</a> using the <a target=_blank href="http://dmsl.github.com/smartbib/">Smartbib</a> project</small></center>'
    
    def html_publication(self, pub_type: str, fields: List[str], element: int) -> None:
        """Generate HTML for a single publication."""
        delimiter = ", "
        
        # Add section headers when the publication type changes
        if self.last_type != self.sorted_items['type'][element]:
            self.last_type = self.sorted_items['type'][element]
            self.resulted_html += f'<li><h2>{self.get_title(self.sorted_items["type"][element])}</h2></li>'
        
        self.resulted_html += f'<li class="{self.sorted_items["year"][element]} publication" title="{self.sorted_items["year"][element]}">'
        self.count_types(element, self.sorted_items['type'][element])
        
        for field in fields:
            if field in self.sorted_items and element < len(self.sorted_items[field]) and self.sorted_items[field][element]:
                value = self.sorted_items[field][element]
                
                if field == "title":
                    self.resulted_html += '<strong>"'
                    if element < len(self.sorted_items.get('durl', [])) and self.sorted_items['durl'][element]:
                        self.resulted_html += f'<a href="{self.sorted_items["durl"][element]}" class="publications-title" target="_blank">'
                    self.resulted_html += value
                    if element < len(self.sorted_items.get('durl', [])) and self.sorted_items['durl'][element]:
                        self.resulted_html += '</a>'
                    self.resulted_html += f'"</strong>{delimiter} '
                    
                elif field == "booktitle":
                    if self.sorted_items['type'][element] == "editorial":
                        self.resulted_html += f'<b>"{value}"</b> '
                    else:
                        self.resulted_html += f'<b>"{value}"</b> '
                        
                elif field == "journal":
                    self.resulted_html += f'<i><b>{value}</b></i> '
                    
                elif field == "year":
                    self.resulted_html += f'<strong>{value}</strong>.'
                    self.year_data.append(value)
                    
                elif field == "numpages":
                    self.resulted_html += f'{value}{delimiter}'
                    
                elif field == "pages":
                    self.resulted_html += f' Pages: {value}{delimiter}'
                    
                elif field == "series":
                    if element < len(self.sorted_items.get('infosite', [])) and self.sorted_items['infosite'][element]:
                        self.resulted_html += f'(<strong><u><a href="{self.sorted_items["infosite"][element]}" class="series-link" target="_blank">{value}</a></u></strong>), '
                    else:
                        self.resulted_html += f'(<strong>{value}</strong>), '
                        
                elif field == "isbn":
                    self.resulted_html += f' ISBN: {value}{delimiter}'
                    
                elif field == "volume":
                    self.resulted_html += f' Volume {value}{delimiter}'
                    
                elif field == "chapter":
                    self.resulted_html += f' Chapter {value}{delimiter}'
                    
                elif field == "author" or field == "location":
                    self.resulted_html += f'{value} '
                    
                else:
                    self.resulted_html += f'{value}{delimiter}'
        
        # Add links to BibTeX, PDF, PowerPoint, etc.
        if element < len(self.sorted_items.get('raw', [])) and self.sorted_items['raw'][element]:
            self.resulted_html += f'&nbsp;<a href="#bibtex-{element}" title="Bibtex Citation" id="publink-{element}"><i class="fa fa-bold">&nbsp;</i></a>'
            self.resulted_html += f'<div style="display:none"><div id="bibtex-{element}"><pre>{self.sorted_items["raw"][element]}</pre></div></div>'
            
        if element < len(self.sorted_items.get('durl', [])) and self.sorted_items['durl'][element]:
            self.resulted_html += f'<a target="_blank" title="PDF" class="publications-title" href="{self.sorted_items["durl"][element]}"><i class="fa fa-file-pdf-o">&nbsp;</i></a>'
            
        if element < len(self.sorted_items.get('powerpoint', [])) and self.sorted_items['powerpoint'][element]:
            self.resulted_html += f'<a target="_blank" title="Powerpoint" class="publications-title" href="{self.sorted_items["powerpoint"][element]}"><i class="fa fa-file-powerpoint-o">&nbsp;</i></a>'
            
        if element < len(self.sorted_items.get('website', [])) and self.sorted_items['website'][element]:
            self.resulted_html += f'<a target="_blank" title="Related Website" class="publications-title" href="{self.sorted_items["website"][element]}"><i class="fa fa-globe">&nbsp;</i></a>'
            
        self.resulted_html += '</li>'
    
    def count_types(self, iterator: int, pub_type: str) -> None:
        """Count the number of publications of each type for labeling."""
        previous = self.sorted_items['type'][:iterator + 1]
        counts = {}
        
        for t in previous:
            counts[t] = counts.get(t, 0) + 1
            
        number = counts.get(pub_type, 0)
        
        if pub_type == 'book':
            self.resulted_html += f"<strong>[B{number}]</strong> "
        else:
            self.resulted_html += f"<strong>[{pub_type[0].upper()}{number}]</strong> "
    
    def print_publications(self) -> str:
        """Generate HTML for the publication filters and list."""
        html = '<ul id="publication-filter">'
        html += '<li><a href="#" class="current" data-filter="*">All</a></li>'
        
        # Create a set of unique years and convert back to list for sorting
        unique_years = list(set(year for year in self.year_data if year))
        unique_years.sort(reverse=True)  # Sort in descending order
        
        for year in unique_years:
            html += f'<li><a href="#" data-filter=".{year}">{year}</a></li>'
                
        html += '</ul>'
        html += '<div style="clear:both;"></div>'
        html += self.resulted_html
        
        return html
    
    def process(self, projects: List[str] = ['all']) -> Dict:
        """
        Process the BibTeX data and prepare it for display.
        
        Args:
            projects: List of project names to filter by
            
        Returns:
            Dict containing publications grouped by category and year, and year filter data
        """
        # Parse and sort the BibTeX data
        self.parse()
        self.sort_items()
        
        # Group publications by category and year
        grouped_publications = {}
        
        for i in range(len(self.types)):
            if not self.check_project(i, projects):
                continue
                
            category = self.get_title(self.sorted_items['type'][i])
            year = self.sorted_items['year'][i] if i < len(self.sorted_items['year']) else 'Unknown'
            
            if not year or not year.isdigit():
                year = 'Unknown'
                
            if year != 'Unknown':
                # Collect years for the filter
                if year not in self.year_data:
                    self.year_data.append(year)
                
            if category not in grouped_publications:
                grouped_publications[category] = {}
                
            if year not in grouped_publications[category]:
                grouped_publications[category][year] = []
                
            # Add the publication to the appropriate group
            publication = {}
            for key in self.sorted_items.keys():
                if i < len(self.sorted_items[key]):
                    publication[key] = self.sorted_items[key][i]
                    
            # Add a counter for this type (similar to [J1], [C2], etc.)
            publication['counter'] = self.count_publication_type(i, self.sorted_items['type'][i])
                    
            grouped_publications[category][year].append(publication)
        
        # Sort years in descending order
        self.year_data = list(set(self.year_data))  # Remove duplicates
        self.year_data.sort(reverse=True)
        
        # Sort years in each category
        for category in grouped_publications:
            grouped_publications[category] = {year: grouped_publications[category][year] 
                                           for year in sorted(grouped_publications[category].keys(), 
                                                             key=lambda x: 0 if x == 'Unknown' else int(x), 
                                                             reverse=True)}
        
        # Generate the HTML output
        self.prepare_html(projects)
        
        return {
            'publications': grouped_publications,
            'years': self.year_data,
            'html_output': self.print_publications()
        }
    
    def count_publication_type(self, index: int, pub_type: str) -> str:
        """
        Count the number of publications of a certain type that appeared before this one.
        Used for labeling like [J1], [C2], etc.
        """
        previous = self.sorted_items['type'][:index+1]
        counts = {}
        
        for t in previous:
            counts[t] = counts.get(t, 0) + 1
        
        number = counts.get(pub_type, 0)
        
        if pub_type == 'book':
            return f"[B{number}]"
        else:
            return f"[{pub_type[0].upper()}{number}]"
    
    @staticmethod
    def str_last_replace(search: str, replace: str, subject: str) -> str:
        """Replace the last occurrence of a string."""
        pos = subject.rfind(search)
        if pos != -1:
            subject = subject[:pos] + replace + subject[pos+len(search):]
        return subject
