FROM meltano/meltano:v3.7.1
WORKDIR /project
COPY meltano.yml ./
# Meltano 3.x doesn't bundle the plugin hub registry — fetch the plugin
# definitions, then install. Without this, every `meltano install` fails
# with "Extractor 'tap-X' is not known to Meltano".
RUN meltano lock --update --all && meltano install
# The target-bigquery venv pulls in `fs`, whose __init__.py calls
# `pkg_resources.declare_namespace(__name__)`. setuptools >=81 removed
# pkg_resources, so on first run the loader crashes with
# `ModuleNotFoundError: No module named 'pkg_resources'`. Pin the
# loader venv's setuptools to a version that still ships pkg_resources.
RUN .meltano/loaders/target-bigquery/venv/bin/pip install 'setuptools<81'
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
