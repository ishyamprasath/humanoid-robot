import logging
from logging.handlers import RotatingFileHandler
import os

LOG_FILE = "demo.log"

def setup_logger():
    logger = logging.getLogger("FaceDemo")
    logger.setLevel(logging.INFO)
    
    if not logger.handlers:
        # File handler
        fh = RotatingFileHandler(LOG_FILE, maxBytes=2*1024*1024, backupCount=3)
        fh.setLevel(logging.INFO)
        formatter = logging.Formatter('%(asctime)s %(levelname)-8s %(message)s', datefmt='%H:%M:%S')
        fh.setFormatter(formatter)
        logger.addHandler(fh)
        
        # Console handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)
        ch.setFormatter(formatter)
        logger.addHandler(ch)

    return logger

_logger = setup_logger()

def log_event(message):
    _logger.info(message)

def log_warning(message):
    _logger.warning(message)

def log_error(message, exc_info=False):
    _logger.error(message, exc_info=exc_info)
