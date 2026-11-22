try:
    from .assets_plus import api  # noqa: F401  # register routes
    from .assets_plus.config import load_config
    from .assets_plus.logs import apply_level
    from .assets_plus.updates import start_banner

    apply_level(load_config().log_level)
    start_banner()
except ImportError:
    pass  # running outside ComfyUI (e.g. tests)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
