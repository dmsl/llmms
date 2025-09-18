# import logging
# from logging.handlers import RotatingFileHandler


# def setup_logging(app):
#     """
#     Set up logging for the application using rotating file handler and more.
#     """
#     # Basic logging config for the root logger
#     logging.basicConfig(
#         level=logging.DEBUG,
#         format="%(asctime)s - %(levelname)s - %(message)s",
#     )

#     # Create a rotating file handler
#     file_handler = RotatingFileHandler(
#         "/home/konstantinkrasovitskiy/flask_app_modules/app.log",
#         maxBytes=5 * 1024 * 1024,  # 5 MB
#         backupCount=3,
#     )
#     file_handler.setLevel(logging.DEBUG)
#     formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
#     file_handler.setFormatter(formatter)
#     app.logger.addHandler(file_handler)

#     # Additional debug log file
#     debug_file_handler = logging.FileHandler(
#         "/home/konstantinkrasovitskiy/flask_app_modules/flask_debug.log"
#     )
#     debug_file_handler.setLevel(logging.DEBUG)
#     debug_file_handler.setFormatter(formatter)
#     app.logger.addHandler(debug_file_handler)

#     # Optionally set the Flask logger level
#     app.logger.setLevel(logging.DEBUG)
