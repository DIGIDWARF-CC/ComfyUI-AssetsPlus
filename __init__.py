try:
    from .assets_plus import api  # noqa: F401  # register routes
    from .assets_plus.config import load_config
    from .assets_plus.logs import apply_level
    from .assets_plus.banner import announce

    apply_level(load_config().log_level)
    announce()
except ImportError:
    pass  # running outside ComfyUI (e.g. tests)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
